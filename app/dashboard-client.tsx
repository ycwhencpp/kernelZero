"use client";

import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ContentItem,
  DashboardState,
  Episode,
  InterestProfile,
} from "../lib/types";
import { formatDuration } from "../lib/domain";

type View = "discover" | "inbox" | "library" | "studio" | "radar";
type Modal = "interest" | "source" | null;

const navItems: Array<{ id: View; label: string; icon: string }> = [
  { id: "discover", label: "Discover", icon: "✦" },
  { id: "inbox", label: "Daily inbox", icon: "↘" },
  { id: "library", label: "Library", icon: "□" },
  { id: "studio", label: "Podcast studio", icon: "◉" },
  { id: "radar", label: "Tech radar", icon: "⌁" },
];

function requestJson<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  return fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  }).then(async (response) => {
    const payload = (await response.json().catch(() => ({}))) as T & {
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  });
}

function dateLabel(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString("en", { month: "short", day: "numeric" });
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function Waveform({ active = false }: { active?: boolean }) {
  const heights = [10, 18, 24, 13, 28, 19, 32, 16, 25, 11, 30, 21, 14, 27, 18, 12, 23, 16];
  return (
    <span className={`waveform ${active ? "is-active" : ""}`} aria-hidden="true">
      {heights.map((height, index) => (
        <span key={`${height}-${index}`} style={{ height }} />
      ))}
    </span>
  );
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "lime" | "coral" | "blue";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function DashboardClient({
  initialState,
}: {
  initialState: DashboardState;
}) {
  const [state, setState] = useState(initialState);
  const [view, setView] = useState<View>("discover");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [trend, setTrend] = useState<ContentItem["trend"]>("latest");
  const [selectedEpisodeId, setSelectedEpisodeId] = useState(
    initialState.episodes[0]?.id ?? "",
  );
  const [selectedRadarId, setSelectedRadarId] = useState(
    initialState.radar[0]?.id ?? "",
  );
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };

  useEffect(() => {
    requestJson<DashboardState>("/api/state")
      .then((fresh) => setState(fresh))
      .catch(() => {
        // The complete demo is intentionally available while cloud state starts.
      });
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      window.speechSynthesis?.cancel();
    };
  }, []);

  const visibleItems = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return state.items.filter((item) => {
      if (!query) return true;
      return `${item.title} ${item.summary} ${item.authors.join(" ")} ${item.topics.join(" ")}`
        .toLowerCase()
        .includes(query);
    });
  }, [state.items, deferredSearch]);

  const selectedEpisode =
    state.episodes.find((episode) => episode.id === selectedEpisodeId) ??
    state.episodes[0];

  const navigate = (nextView: View) => {
    setView(nextView);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const syncResearch = async (interestId?: string) => {
    setBusy("sync");
    try {
      const payload = await requestJson<{
        imported: number;
        warnings: string[];
        state: DashboardState;
      }>("/api/discover", {
        method: "POST",
        body: JSON.stringify({ interestId }),
      });
      setState(payload.state);
      notify(
        payload.imported
          ? `Found ${payload.imported} new research items.`
          : "Sources are current. No duplicates added.",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "Research sync failed.");
    } finally {
      setBusy(null);
    }
  };

  const toggleSave = async (item: ContentItem) => {
    const nextSaved = !item.saved;
    setState((current) => ({
      ...current,
      items: current.items.map((candidate) =>
        candidate.id === item.id ? { ...candidate, saved: nextSaved } : candidate,
      ),
    }));
    try {
      const payload = await requestJson<{ state: DashboardState }>(
        `/api/items/${encodeURIComponent(item.id)}/save`,
        { method: "POST", body: JSON.stringify({ saved: nextSaved }) },
      );
      setState(payload.state);
      notify(nextSaved ? "Saved to your library." : "Removed from saved items.");
    } catch {
      notify("Saved locally; cloud sync will retry.");
    }
  };

  const sendFeedback = async (
    itemId: string,
    action: "skipped" | "listened" | "rating",
    value?: number,
    quiet = false,
  ) => {
    try {
      const payload = await requestJson<{ state: DashboardState }>(
        `/api/items/${encodeURIComponent(itemId)}/feedback`,
        {
          method: "POST",
          body: JSON.stringify({ action, value }),
        },
      );
      setState(payload.state);
      if (!quiet) {
        notify(
          action === "skipped"
            ? "Skipped. Similar signals will rank lower."
            : action === "listened"
              ? "Marked listened. Your ranking profile was updated."
              : `Rated ${value}/5. Future recommendations will adapt.`,
        );
      }
    } catch (error) {
      if (!quiet) {
        notify(error instanceof Error ? error.message : "Feedback sync failed.");
      }
    }
  };

  const generateEpisode = async (
    type: Episode["type"],
    itemIds: string[] = [],
  ) => {
    setBusy(`generate:${itemIds[0] ?? type}`);
    try {
      const payload = await requestJson<{
        episode: Episode;
        provider: "openai" | "demo";
        state: DashboardState;
      }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({ type, itemIds, includeAudio: true }),
      });
      setState(payload.state);
      setSelectedEpisodeId(payload.episode.id);
      setView("studio");
      notify(
        payload.provider === "openai"
          ? "Evidence-checked script and audio are ready for review."
          : "Demo script is ready. Connect OpenAI to render full audio.",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "Generation failed.");
    } finally {
      setBusy(null);
    }
  };

  const approveEpisode = async (episodeId: string) => {
    setBusy(`approve:${episodeId}`);
    try {
      const payload = await requestJson<{ state: DashboardState }>(
        `/api/episodes/${encodeURIComponent(episodeId)}/approve`,
        { method: "POST" },
      );
      setState(payload.state);
      notify("Episode approved. It will enter the public feed when audio is attached.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Approval failed.");
    } finally {
      setBusy(null);
    }
  };

  const previewEpisode = (episode: Episode) => {
    if (episode.contentItemId) {
      void sendFeedback(episode.contentItemId, "listened", 1, true);
    }
    if (episode.audioUrl) {
      const audio = new Audio(episode.audioUrl);
      void audio.play();
      setPlayingId(episode.id);
      audio.onended = () => setPlayingId(null);
      return;
    }
    if (!("speechSynthesis" in window)) {
      notify("Audio preview is unavailable in this browser.");
      return;
    }
    if (playingId === episode.id) {
      window.speechSynthesis.cancel();
      setPlayingId(null);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(episode.script.slice(0, 1100));
    utterance.rate = 0.96;
    utterance.pitch = 0.96;
    utterance.onend = () => setPlayingId(null);
    window.speechSynthesis.speak(utterance);
    setPlayingId(episode.id);
    notify("Playing a browser voice preview of the draft.");
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate("discover")} aria-label="SignalCast home">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>signalcast</span>
        </button>

        <nav className="primary-nav" aria-label="Main navigation">
          <p className="nav-label">Workspace</p>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "is-active" : ""}
              onClick={() => navigate(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === "inbox" && <em>{state.stats.newToday}</em>}
            </button>
          ))}
        </nav>

        <div className="sidebar-section">
          <div className="sidebar-section-title">
            <span>Interests</span>
            <button onClick={() => setModal("interest")} aria-label="Add interest">+</button>
          </div>
          {state.interests.slice(0, 4).map((interest, index) => (
            <button
              key={interest.id}
              className="interest-link"
              onClick={() => void syncResearch(interest.id)}
              disabled={busy === "sync"}
            >
              <span className={`interest-dot interest-dot-${index + 1}`} />
              <span>{interest.name}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="budget-mini">
            <div><span>Today’s AI spend</span><strong>${state.stats.dailySpendUsd.toFixed(2)}</strong></div>
            <span className="progress"><i style={{ width: `${Math.min(100, state.stats.dailySpendUsd / state.stats.dailyBudgetUsd * 100)}%` }} /></span>
            <small>${state.stats.dailyBudgetUsd.toFixed(2)} daily limit</small>
          </div>
          <button className="profile-button">
            <span className="avatar">AS</span>
            <span><strong>Anurag</strong><small>Personal workspace</small></span>
            <span>···</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mobile-brand">
            <span className="brand-mark"><i /><i /><i /></span>
            <strong>signalcast</strong>
          </div>
          <label className="search-box">
            <span>⌕</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search papers, ideas, authors…"
              aria-label="Search the knowledge library"
            />
            <kbd>⌘ K</kbd>
          </label>
          <div className="top-actions">
            <span className="sync-status"><i /> Synced {state.stats.lastSync}</span>
            <button className="icon-button" aria-label="Notifications">◔<em>2</em></button>
            <button
              className="button button-dark"
              onClick={() => void generateEpisode("daily_digest")}
              disabled={busy !== null}
            >
              <span>✦</span> New episode
            </button>
          </div>
        </header>

        {view === "discover" && (
          <DiscoverView
            state={state}
            items={visibleItems}
            trend={trend}
            setTrend={setTrend}
            navigate={navigate}
            toggleSave={toggleSave}
            generateEpisode={generateEpisode}
            syncResearch={syncResearch}
            setModal={setModal}
            busy={busy}
            playingId={playingId}
            previewEpisode={previewEpisode}
          />
        )}
        {view === "inbox" && (
          <InboxView
            items={visibleItems}
            sources={state.sources}
            toggleSave={toggleSave}
            generateEpisode={generateEpisode}
            sendFeedback={sendFeedback}
            setModal={setModal}
            busy={busy}
          />
        )}
        {view === "library" && (
          <LibraryView
            state={state}
            items={visibleItems}
            toggleSave={toggleSave}
            generateEpisode={generateEpisode}
            sendFeedback={sendFeedback}
            busy={busy}
          />
        )}
        {view === "studio" && selectedEpisode && (
          <StudioView
            state={state}
            episode={selectedEpisode}
            selectedEpisodeId={selectedEpisodeId}
            setSelectedEpisodeId={setSelectedEpisodeId}
            approveEpisode={approveEpisode}
            previewEpisode={previewEpisode}
            playingId={playingId}
            busy={busy}
            notify={notify}
            sendFeedback={sendFeedback}
            generateEpisode={generateEpisode}
          />
        )}
        {view === "radar" && (
          <RadarView
            state={state}
            selectedRadarId={selectedRadarId}
            setSelectedRadarId={setSelectedRadarId}
          />
        )}
      </main>

      {modal && (
        <ModalPanel
          modal={modal}
          close={() => setModal(null)}
          setState={setState}
          notify={notify}
        />
      )}
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </div>
  );
}

function DiscoverView({
  state,
  items,
  trend,
  setTrend,
  navigate,
  toggleSave,
  generateEpisode,
  syncResearch,
  setModal,
  busy,
  playingId,
  previewEpisode,
}: {
  state: DashboardState;
  items: ContentItem[];
  trend: ContentItem["trend"];
  setTrend: (trend: ContentItem["trend"]) => void;
  navigate: (view: View) => void;
  toggleSave: (item: ContentItem) => Promise<void>;
  generateEpisode: (type: Episode["type"], ids?: string[]) => Promise<void>;
  syncResearch: (interestId?: string) => Promise<void>;
  setModal: (modal: Modal) => void;
  busy: string | null;
  playingId: string | null;
  previewEpisode: (episode: Episode) => void;
}) {
  const digest = state.episodes.find((episode) => episode.type === "daily_digest");
  const filtered = items.filter((item) => item.trend === trend).slice(0, 6);

  return (
    <div className="page-content">
      <section className="welcome-row">
        <div>
          <p className="eyebrow">Saturday, 25 July</p>
          <h1>Good morning, Anurag.</h1>
          <p>Your research signal is unusually strong today.</p>
        </div>
        <div className="quick-stats">
          <div><strong>{state.stats.newToday}</strong><span>new signals</span></div>
          <div><strong>{state.stats.savedItems}</strong><span>saved this week</span></div>
          <div><strong>{state.stats.listeningMinutes}</strong><span>minutes learned</span></div>
        </div>
      </section>

      <section className="hero-grid">
        <article className="daily-brief-card">
          <div className="brief-top">
            <div>
              <Badge tone="lime">Ready to review</Badge>
              <p className="mono-label">Your daily briefing · 12 min</p>
            </div>
            <span className="ai-badge">AI narrated</span>
          </div>
          <div className="brief-main">
            <div className="cover-art">
              <span className="cover-kicker">DAILY<br />SIGNAL</span>
              <Waveform />
              <strong>25<span>/07</span></strong>
            </div>
            <div className="brief-copy">
              <h2>{digest?.title ?? "The Daily Signal"}</h2>
              <p>{digest?.dek}</p>
              <div className="brief-topics">
                <span>Reasoning models</span><i />
                <span>Agent infrastructure</span><i />
                <span>Edge AI</span>
              </div>
              <div className="brief-actions">
                {digest && (
                  <button className="play-button" onClick={() => previewEpisode(digest)}>
                    <span>{playingId === digest.id ? "Ⅱ" : "▶"}</span>
                    {playingId === digest.id ? "Pause preview" : "Preview draft"}
                  </button>
                )}
                <button className="button button-light" onClick={() => navigate("studio")}>Review episode →</button>
              </div>
            </div>
          </div>
          <div className="brief-footer">
            <span><i className="shield">✓</i> 8/8 claims linked to evidence</span>
            <span>5 sources · 4 chapters · transcript ready</span>
          </div>
        </article>

        <aside className="signal-summary">
          <div className="summary-header">
            <div><span className="pulse-dot" /><strong>Signal summary</strong></div>
            <button onClick={() => navigate("radar")}>Open radar ↗</button>
          </div>
          <div className="summary-metric">
            <div><span>Fastest rising</span><strong>Agent observability</strong></div>
            <em>+42%</em>
          </div>
          <div className="mini-chart" aria-label="Agent observability trend rose over the past 30 days">
            {[22, 31, 28, 39, 45, 52, 48, 64, 69, 82].map((value, index) => (
              <i key={index} style={{ height: `${value}%` }} />
            ))}
          </div>
          <div className="summary-list">
            {state.radar.slice(1, 4).map((topic) => (
              <div key={topic.id}>
                <span className={`topic-icon topic-${topic.category.toLowerCase()}`}>{topic.name[0]}</span>
                <span><strong>{topic.name}</strong><small>{topic.itemCount} fresh sources</small></span>
                <em>{topic.changeLabel}</em>
              </div>
            ))}
          </div>
        </aside>
      </section>

      <section className="section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Your research landscape</p>
            <h2>Worth your attention</h2>
          </div>
          <div className="heading-actions">
            <div className="interest-pills">
              {state.interests.map((interest) => <span key={interest.id}>{interest.name}</span>)}
              <button onClick={() => setModal("interest")}>+</button>
            </div>
            <button
              className="button button-outline"
              onClick={() => void syncResearch()}
              disabled={busy === "sync"}
            >
              {busy === "sync" ? "Searching…" : "Refresh sources"}
            </button>
          </div>
        </div>

        <div className="filter-tabs">
          {(["latest", "foundational", "rising"] as const).map((value) => (
            <button
              key={value}
              className={trend === value ? "is-active" : ""}
              onClick={() => setTrend(value)}
            >
              {titleCase(value)}
              <span>{items.filter((item) => item.trend === value).length}</span>
            </button>
          ))}
        </div>

        <div className="content-grid">
          {filtered.map((item, index) => (
            <ContentCard
              key={item.id}
              item={item}
              accent={["green", "blue", "coral"][index % 3]}
              toggleSave={toggleSave}
              generateEpisode={generateEpisode}
              busy={busy}
            />
          ))}
          {filtered.length === 0 && (
            <div className="empty-state">
              <span>⌕</span>
              <h3>No matching signals yet</h3>
              <p>Refresh your sources or adjust the search to widen the field.</p>
              <button className="button button-dark" onClick={() => void syncResearch()}>Search research sources</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ContentCard({
  item,
  accent,
  toggleSave,
  generateEpisode,
  busy,
}: {
  item: ContentItem;
  accent: string;
  toggleSave: (item: ContentItem) => Promise<void>;
  generateEpisode: (type: Episode["type"], ids?: string[]) => Promise<void>;
  busy: string | null;
}) {
  const generationKey = `generate:${item.id}`;
  return (
    <article className={`content-card accent-${accent}`}>
      <div className="card-meta">
        <div>
          <Badge tone={item.kind === "paper" ? "blue" : "coral"}>
            {item.kind === "paper" ? "Research paper" : "Engineering blog"}
          </Badge>
          {item.peerReviewState === "preprint" && <span className="preprint-label">Preprint</span>}
        </div>
        <button
          className={`bookmark ${item.saved ? "is-saved" : ""}`}
          onClick={() => void toggleSave(item)}
          aria-label={item.saved ? "Remove from saved" : "Save to library"}
        >
          {item.saved ? "◆" : "◇"}
        </button>
      </div>
      <div className="score-ring" style={{ "--score": `${item.score * 3.6}deg` } as React.CSSProperties}>
        <span>{item.score}</span>
      </div>
      <h3>{item.title}</h3>
      <p>{item.summary}</p>
      <div className="card-source">
        <span className="source-logo">{item.sourceName.slice(0, 2).toUpperCase()}</span>
        <span><strong>{item.sourceName}</strong><small>{dateLabel(item.publishedAt)} · {item.readingMinutes} min read</small></span>
      </div>
      <div className="topic-tags">
        {item.topics.slice(0, 3).map((topic) => <span key={topic}>{topic}</span>)}
      </div>
      <div className="card-actions">
        <a href={item.canonicalUrl} target="_blank" rel="noreferrer">Open source ↗</a>
        <button
          onClick={() =>
            void generateEpisode(
              item.kind === "paper" ? "paper_deep_dive" : "blog_deep_dive",
              [item.id],
            )
          }
          disabled={busy !== null}
        >
          {busy === generationKey ? "Creating…" : "✦ Make podcast"}
        </button>
      </div>
    </article>
  );
}

function InboxView({
  items,
  sources,
  toggleSave,
  generateEpisode,
  sendFeedback,
  setModal,
  busy,
}: {
  items: ContentItem[];
  sources: DashboardState["sources"];
  toggleSave: (item: ContentItem) => Promise<void>;
  generateEpisode: (type: Episode["type"], ids?: string[]) => Promise<void>;
  sendFeedback: (
    itemId: string,
    action: "skipped" | "listened" | "rating",
    value?: number,
  ) => Promise<void>;
  setModal: (modal: Modal) => void;
  busy: string | null;
}) {
  return (
    <div className="page-content">
      <section className="page-title-row">
        <div><p className="eyebrow">Curated at 05:30 IST</p><h1>Daily inbox</h1><p>One calm queue across research and trusted engineering feeds.</p></div>
        <button className="button button-dark" onClick={() => setModal("source")}>+ Add source</button>
      </section>
      <div className="inbox-layout">
        <section className="inbox-list">
          <div className="inbox-list-head">
            <span>{items.length} items after deduplication</span>
            <span>Sorted by signal score</span>
          </div>
          {items.map((item) => (
            <article className="inbox-row" key={item.id}>
              <div className="inbox-kind"><span>{item.kind === "paper" ? "P" : "B"}</span><small>{item.score}</small></div>
              <div className="inbox-copy">
                <div><Badge tone={item.kind === "paper" ? "blue" : "coral"}>{item.kind}</Badge><span>{item.sourceName}</span><span>·</span><span>{dateLabel(item.publishedAt)}</span></div>
                <h3>{item.title}</h3>
                <p>{item.summary}</p>
                <div className="topic-tags">{item.topics.slice(0, 3).map((topic) => <span key={topic}>{topic}</span>)}</div>
              </div>
              <div className="inbox-actions">
                <button onClick={() => void toggleSave(item)}>{item.saved ? "Saved ◆" : "Save ◇"}</button>
                <button onClick={() => void sendFeedback(item.id, "skipped")}>Skip</button>
                <button
                  className="button button-outline"
                  disabled={busy !== null}
                  onClick={() => void generateEpisode(item.kind === "paper" ? "paper_deep_dive" : "blog_deep_dive", [item.id])}
                >
                  ✦ Podcast
                </button>
              </div>
            </article>
          ))}
        </section>
        <aside className="sources-panel">
          <div className="panel-title"><div><p className="eyebrow">Allowlist</p><h3>Trusted sources</h3></div><button onClick={() => setModal("source")}>+</button></div>
          {sources.map((source) => (
            <div className="source-row" key={source.id}>
              <span className="source-logo">{source.name.slice(0, 2).toUpperCase()}</span>
              <span><strong>{source.name}</strong><small>{titleCase(source.rightsMode)} · {source.lastSuccessfulFetch ? "healthy" : "pending"}</small></span>
              <i className={source.enabled ? "is-on" : ""} />
            </div>
          ))}
          <div className="rights-note"><span>ⓘ</span><p>SignalCast stores feed content or permitted metadata. Full papers are retained only when open access or uploaded by you.</p></div>
        </aside>
      </div>
    </div>
  );
}

function LibraryView({
  state,
  items,
  toggleSave,
  generateEpisode,
  sendFeedback,
  busy,
}: {
  state: DashboardState;
  items: ContentItem[];
  toggleSave: (item: ContentItem) => Promise<void>;
  generateEpisode: (type: Episode["type"], ids?: string[]) => Promise<void>;
  sendFeedback: (
    itemId: string,
    action: "skipped" | "listened" | "rating",
    value?: number,
  ) => Promise<void>;
  busy: string | null;
}) {
  const saved = items.filter((item) => item.saved);
  return (
    <div className="page-content">
      <section className="page-title-row">
        <div><p className="eyebrow">Your durable knowledge base</p><h1>Library</h1><p>Sources, listening, notes, and collections — all in one place.</p></div>
        <button className="button button-dark">+ New collection</button>
      </section>
      <div className="collection-grid">
        {state.collections.map((collection, index) => (
          <article className="collection-card" key={collection.id} style={{ "--collection": collection.color } as React.CSSProperties}>
            <div className="collection-stack"><i /><i /><i /></div>
            <div><span>Collection {String(index + 1).padStart(2, "0")}</span><h3>{collection.name}</h3><p>{collection.description}</p></div>
            <footer><span>{collection.itemIds.length} sources</span><button>Open →</button></footer>
          </article>
        ))}
        <button className="collection-card add-collection"><span>+</span><strong>Create a collection</strong><small>Group a learning path</small></button>
      </div>
      <section className="library-table">
        <div className="section-heading compact"><div><p className="eyebrow">Saved for later</p><h2>{saved.length} knowledge objects</h2></div><div className="library-filter"><button className="is-active">All</button><button>Papers</button><button>Blogs</button><button>Listened</button></div></div>
        <div className="table-head"><span>Source</span><span>Topics</span><span>Status</span><span>Action</span></div>
        {saved.map((item) => (
          <div className="library-row" key={item.id}>
            <div><span className="source-logo">{item.kind === "paper" ? "P" : "B"}</span><span><strong>{item.title}</strong><small>{item.authors.slice(0, 2).join(", ") || item.sourceName}</small></span></div>
            <div className="topic-tags">{item.topics.slice(0, 2).map((topic) => <span key={topic}>{topic}</span>)}</div>
            <div><Badge tone={item.listened ? "lime" : "neutral"}>{item.listened ? "Listened" : "Unread"}</Badge></div>
            <div>
              <button className="row-action" onClick={() => void generateEpisode(item.kind === "paper" ? "paper_deep_dive" : "blog_deep_dive", [item.id])} disabled={busy !== null}>✦ Podcast</button>
              <button className="row-action" onClick={() => void sendFeedback(item.id, "listened", 1)}>Mark listened</button>
              <button className="row-action" onClick={() => void toggleSave(item)}>Remove</button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function StudioView({
  state,
  episode,
  selectedEpisodeId,
  setSelectedEpisodeId,
  approveEpisode,
  previewEpisode,
  playingId,
  busy,
  notify,
  sendFeedback,
  generateEpisode,
}: {
  state: DashboardState;
  episode: Episode;
  selectedEpisodeId: string;
  setSelectedEpisodeId: (id: string) => void;
  approveEpisode: (id: string) => Promise<void>;
  previewEpisode: (episode: Episode) => void;
  playingId: string | null;
  busy: string | null;
  notify: (message: string) => void;
  sendFeedback: (
    itemId: string,
    action: "skipped" | "listened" | "rating",
    value?: number,
  ) => Promise<void>;
  generateEpisode: (
    type: Episode["type"],
    ids?: string[],
  ) => Promise<void>;
}) {
  const evidence = state.evidence.filter((claim) => claim.episodeId === episode.id);
  return (
    <div className="studio-shell">
      <aside className="episode-queue">
        <div><p className="eyebrow">Episode queue</p><h2>Studio</h2></div>
        {state.episodes.map((candidate) => (
          <button
            key={candidate.id}
            className={candidate.id === selectedEpisodeId ? "is-active" : ""}
            onClick={() => setSelectedEpisodeId(candidate.id)}
          >
            <span className={`episode-type episode-${candidate.type}`}>{candidate.type === "daily_digest" ? "D" : "P"}</span>
            <span><strong>{candidate.title}</strong><small>{formatDuration(candidate.durationSeconds)} · {titleCase(candidate.status)}</small></span>
          </button>
        ))}
        <div className="studio-feed-card">
          <span>RSS feed</span>
          <strong>/feed.xml</strong>
          <button onClick={() => {
            void navigator.clipboard?.writeText(`${location.origin}/feed.xml`);
            notify("Feed URL copied.");
          }}>Copy link</button>
        </div>
      </aside>
      <div className="studio-main">
        <header className="studio-header">
          <div><Badge tone={episode.status === "needs_approval" ? "coral" : "lime"}>{titleCase(episode.status)}</Badge><span>Generation {episode.generation}</span><span>·</span><span>{episode.citations.length} sources</span></div>
          <div>
            <button
              className="button button-outline"
              disabled={busy !== null}
              onClick={() =>
                void generateEpisode(
                  episode.type,
                  episode.contentItemId ? [episode.contentItemId] : [],
                )
              }
            >
              {busy?.startsWith("generate:") ? "Regenerating…" : "Regenerate"}
            </button>
            <button
              className="button button-dark"
              onClick={() => void approveEpisode(episode.id)}
              disabled={busy !== null || ["approved", "published"].includes(episode.status)}
            >
              {busy === `approve:${episode.id}` ? "Approving…" : episode.status === "published" ? "Published ✓" : episode.status === "approved" ? "Approved ✓" : "Approve episode"}
            </button>
          </div>
        </header>
        <section className="studio-player">
          <div className="studio-cover"><span>SC</span><Waveform active={playingId === episode.id} /><strong>{episode.type === "daily_digest" ? "DAILY" : "DEEP DIVE"}</strong></div>
          <div className="studio-player-copy">
            <p className="eyebrow">{titleCase(episode.type)} · {formatDuration(episode.durationSeconds)}</p>
            <h1>{episode.title}</h1>
            <p>{episode.dek}</p>
            <div className="audio-control">
              <button onClick={() => previewEpisode(episode)}>{playingId === episode.id ? "Ⅱ" : "▶"}</button>
              <Waveform active={playingId === episode.id} />
              <span>{playingId === episode.id ? "0:18" : "0:00"}</span>
              <span>{formatDuration(episode.durationSeconds)}</span>
            </div>
            {episode.contentItemId && (
              <div className="episode-rating">
                <span>Rate this deep dive</span>
                {[1, 2, 3, 4, 5].map((rating) => (
                  <button
                    key={rating}
                    onClick={() =>
                      void sendFeedback(
                        episode.contentItemId!,
                        "rating",
                        rating,
                      )
                    }
                    aria-label={`Rate ${rating} out of 5`}
                  >
                    {rating}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
        <div className="studio-workspace">
          <article className="script-editor">
            <div className="editor-head"><div><span className="is-active">Script</span><span>Show notes</span><span>Transcript</span></div><span>{episode.script.split(/\s+/).length} words</span></div>
            <h2>{episode.title}</h2>
            {episode.script.split(/\n{2,}/).map((paragraph, index) => (
              <div className="script-paragraph" key={`${paragraph.slice(0, 20)}-${index}`}>
                {index < episode.chapters.length && <span className="chapter-marker">{String(index + 1).padStart(2, "0")} · {episode.chapters[index].title}</span>}
                <p>{paragraph}</p>
              </div>
            ))}
          </article>
          <aside className="evidence-panel">
            <div className="panel-title"><div><p className="eyebrow">Claim ledger</p><h3>{evidence.length}/{evidence.length} grounded</h3></div><span className="verified-orb">✓</span></div>
            {evidence.map((claim, index) => (
              <article key={claim.id}>
                <div><span>{String(index + 1).padStart(2, "0")}</span><em>{Math.round(claim.confidence * 100)}%</em></div>
                <strong>{claim.claim}</strong>
                <p>{claim.support}</p>
                <a href={claim.sourceUrl} target="_blank" rel="noreferrer">{claim.location} ↗</a>
              </article>
            ))}
            {evidence.length === 0 && <div className="empty-evidence"><span>✓</span><p>No unsupported claims detected in this demo draft.</p></div>}
            <div className="preflight">
              <strong>Pre-publish checks</strong>
              <span><i>✓</i> AI narration disclosed</span>
              <span><i>✓</i> Preprints labeled</span>
              <span><i>✓</i> Source links complete</span>
              <span><i>✓</i> No copyrighted music</span>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function RadarView({
  state,
  selectedRadarId,
  setSelectedRadarId,
}: {
  state: DashboardState;
  selectedRadarId: string;
  setSelectedRadarId: (id: string) => void;
}) {
  const selected = state.radar.find((topic) => topic.id === selectedRadarId) ?? state.radar[0];
  return (
    <div className="page-content">
      <section className="page-title-row">
        <div><p className="eyebrow">Cross-source momentum</p><h1>Tech radar</h1><p>What is rising, what is durable, and what is only noise.</p></div>
        <div className="radar-legend"><span><i className="dot-models" />Models</span><span><i className="dot-systems" />Systems</span><span><i className="dot-robotics" />Robotics</span></div>
      </section>
      <div className="radar-layout">
        <section className="radar-map">
          <div className="axis-y"><span>High velocity</span><span>Low velocity</span></div>
          <div className="axis-x"><span>Niche</span><span>Broad adoption</span></div>
          <div className="radar-grid-lines"><i /><i /><i /><i /></div>
          {state.radar.map((topic) => (
            <button
              key={topic.id}
              className={`radar-node node-${topic.category.toLowerCase()} ${topic.id === selectedRadarId ? "is-active" : ""}`}
              style={{ left: `${topic.x}%`, top: `${topic.y}%`, "--size": `${Math.max(54, topic.volume)}px` } as React.CSSProperties}
              onClick={() => setSelectedRadarId(topic.id)}
            >
              <span>{topic.name}</span><em>{topic.changeLabel}</em>
            </button>
          ))}
        </section>
        <aside className="radar-detail">
          <Badge tone="lime">Rising signal</Badge>
          <p className="eyebrow">{selected.category}</p>
          <h2>{selected.name}</h2>
          <p>This topic is appearing across independent research and trusted engineering sources, with sustained movement over the last 30 days.</p>
          <div className="radar-score-grid">
            <div><span>Velocity</span><strong>{selected.velocity}</strong><i><em style={{ width: `${selected.velocity}%` }} /></i></div>
            <div><span>Volume</span><strong>{selected.volume}</strong><i><em style={{ width: `${selected.volume}%` }} /></i></div>
            <div><span>Confidence</span><strong>{selected.confidence}</strong><i><em style={{ width: `${selected.confidence}%` }} /></i></div>
          </div>
          <div className="corroboration">
            <strong>{selected.itemCount} corroborating sources</strong>
            <div><span className="source-logo">OA</span><span className="source-logo">SS</span><span className="source-logo">AR</span><span className="source-logo">+{Math.max(0, selected.itemCount - 3)}</span></div>
          </div>
          <button className="button button-dark">Explore this signal →</button>
        </aside>
      </div>
      <section className="trend-table">
        <div className="table-head"><span>Signal</span><span>Category</span><span>30-day change</span><span>Evidence</span></div>
        {state.radar.map((topic) => (
          <button key={topic.id} onClick={() => setSelectedRadarId(topic.id)}>
            <span><i className={`dot-${topic.category.toLowerCase()}`} /><strong>{topic.name}</strong></span>
            <span>{topic.category}</span><span className="positive">{topic.changeLabel}</span><span>{topic.itemCount} sources →</span>
          </button>
        ))}
      </section>
    </div>
  );
}

function ModalPanel({
  modal,
  close,
  setState,
  notify,
}: {
  modal: Exclude<Modal, null>;
  close: () => void;
  setState: React.Dispatch<React.SetStateAction<DashboardState>>;
  notify: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [keywords, setKeywords] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      if (modal === "interest") {
        const payload = await requestJson<{ interest: InterestProfile; state: DashboardState }>("/api/interests", {
          method: "POST",
          body: JSON.stringify({
            name,
            query,
            keywords: keywords.split(",").map((value) => value.trim()).filter(Boolean),
            freshnessDays: 30,
            weight: 1,
          }),
        });
        setState(payload.state);
        notify(`Now tracking ${payload.interest.name}.`);
      } else {
        const payload = await requestJson<{ imported: number; state: DashboardState }>("/api/sources", {
          method: "POST",
          body: JSON.stringify({ name, url }),
        });
        setState(payload.state);
        notify(`Trusted feed added with ${payload.imported} items.`);
      }
      close();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <button className="modal-close" onClick={close} aria-label="Close">×</button>
        <p className="eyebrow">{modal === "interest" ? "Personalize discovery" : "Expand your inbox"}</p>
        <h2 id="modal-title">{modal === "interest" ? "Track a research interest" : "Add a trusted feed"}</h2>
        <p>{modal === "interest" ? "Describe the questions and technology shifts you want SignalCast to watch." : "Only RSS and Atom feeds you explicitly approve are ingested."}</p>
        <form onSubmit={(event) => void submit(event)}>
          <label><span>{modal === "interest" ? "Interest name" : "Source name (optional)"}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={modal === "interest" ? "e.g. AI hardware" : "e.g. Cloudflare Blog"} required={modal === "interest"} /></label>
          {modal === "interest" ? (
            <>
              <label><span>What should we look for?</span><textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Efficient accelerators, memory systems, inference chips, and compiler advances…" required /></label>
              <label><span>Keywords</span><input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="accelerators, inference, HBM" /><small>Separate with commas</small></label>
            </>
          ) : (
            <label><span>RSS or Atom URL</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/feed.xml" required /></label>
          )}
          <div className="modal-actions"><button type="button" className="button button-light" onClick={close}>Cancel</button><button type="submit" className="button button-dark" disabled={saving}>{saving ? "Saving…" : modal === "interest" ? "Track interest" : "Verify & add feed"}</button></div>
        </form>
      </section>
    </div>
  );
}
