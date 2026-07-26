"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardState, Episode, EpisodeLength, WorkspaceSettings } from "../lib/types";
import {
  OrganicAppShell,
  type OrganicView,
} from "./components/organic/app-shell";
import { OrganicDashboardView } from "./views/organic-dashboard-view";
import { OrganicPublishedView } from "./views/organic-published-view";
import { OrganicSourcesView } from "./views/organic-sources-view";
import { OrganicSettingsView } from "./views/organic-settings-view";
import { OrganicReviewView } from "./views/organic-review-view";
import { OrganicCreateView } from "./views/organic-create-view";

type Modal = "interest" | "source" | null;

function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
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
    if (!response.ok) {
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return payload;
  });
}

const pageTitles: Record<OrganicView, string> = {
  dashboard: "Overview",
  published: "Published Episodes",
  sources: "Manage Sources",
  settings: "Settings",
  review: "",
  create: "",
};

export function DashboardClient({
  initialState,
}: {
  initialState: DashboardState;
}) {
  const [state, setState] = useState(initialState);
  const [view, setView] = useState<OrganicView>("dashboard");
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [footerYear] = useState(() => new Date().getFullYear());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const digest = useMemo(
    () =>
      state.episodes.find((e) => e.type === "daily_digest") ?? state.episodes[0],
    [state.episodes],
  );

  const reviewEpisode = useMemo(() => {
    return (
      state.episodes.find((e) => e.status === "needs_approval") ??
      digest ??
      state.episodes[0]
    );
  }, [state.episodes, digest]);

  const notify = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };

  useEffect(() => {
    requestJson<DashboardState>("/api/state")
      .then((fresh) => setState(fresh))
      .catch(() => undefined);
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      window.speechSynthesis?.cancel();
    };
  }, []);

  const navigate = (next: OrganicView) => {
    setView(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const generateEpisode = async (
    type: Episode["type"],
    itemIds: string[] = [],
    episodeLength?: EpisodeLength,
  ) => {
    setBusy(`generate:${itemIds[0] ?? type}`);
    try {
      const payload = await requestJson<{
        episode: Episode;
        provider: "openai" | "gemini" | "ollama";
        state: DashboardState;
      }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({ type, itemIds, includeAudio: true, episodeLength }),
      });
      setState(payload.state);
      setView("review");
      notify(
        "Evidence-checked script and local audio are ready for review.",
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
      setView("published");
      notify("Episode approved and queued for the public feed.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Approval failed.");
    } finally {
      setBusy(null);
    }
  };

  const previewEpisode = (episode: Episode) => {
    if (episode.audioUrl) {
      if (!audioRef.current || audioRef.current.src !== episode.audioUrl) {
        audioRef.current?.pause();
        audioRef.current = new Audio(episode.audioUrl);
        audioRef.current.onended = () => setPlayingId(null);
      }
      if (playingId === episode.id) {
        audioRef.current.pause();
        setPlayingId(null);
        return;
      }
      void audioRef.current.play();
      setPlayingId(episode.id);
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
    utterance.onend = () => setPlayingId(null);
    window.speechSynthesis.speak(utterance);
    setPlayingId(episode.id);
  };

  const seekEpisode = (delta: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, Math.min(audioRef.current.duration || Infinity, audioRef.current.currentTime + delta));
  };

  const editEpisode = async (episodeId: string, script: string) => {
    const payload = await requestJson<{ state: DashboardState }>(`/api/episodes/${encodeURIComponent(episodeId)}`, {
      method: "PATCH",
      body: JSON.stringify({ script, transcript: script }),
    });
    setState(payload.state);
    notify("Transcript saved.");
  };

  const regenerateEpisodeAudio = async (episodeId: string) => {
    setBusy(`audio:${episodeId}`);
    try {
      const payload = await requestJson<{ state: DashboardState }>(`/api/episodes/${encodeURIComponent(episodeId)}/audio`, { method: "POST" });
      setState(payload.state);
      notify("Audio regenerated with the selected local narrator.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to regenerate audio.");
    } finally {
      setBusy(null);
    }
  };

  const exportEpisode = (episode: Episode) => {
    const blob = new Blob([episode.script], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${episode.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || episode.id}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify("Transcript exported.");
  };

  const deleteWorkspace = async () => {
    if (!window.confirm("Delete all interests, sources, items, jobs, and episodes for this workspace?")) return;
    setBusy("workspace:delete");
    try {
      const payload = await requestJson<{ state: DashboardState }>("/api/workspace", { method: "DELETE" });
      setState(payload.state);
      setView("dashboard");
      notify("Workspace data deleted.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to delete workspace.");
    } finally {
      setBusy(null);
    }
  };

  const createVoice = async (form: FormData) => {
    setBusy("voice:create");
    try {
      const response = await fetch("/api/voices", { method: "POST", body: form });
      const payload = (await response.json().catch(() => ({}))) as {
        state?: DashboardState;
        error?: string;
      };
      if (!response.ok || !payload.state) {
        throw new Error(payload.error || "Unable to save the local voice.");
      }
      setState(payload.state);
      notify("Local narrator is ready. New podcast audio will use this voice.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save the local voice.";
      notify(message);
      throw error;
    } finally {
      setBusy(null);
    }
  };

  const disconnectVoice = async () => {
    setBusy("voice:disconnect");
    try {
      const payload = await requestJson<{ state: DashboardState }>("/api/voices", {
        method: "DELETE",
      });
      setState(payload.state);
      notify("Local narrator removed. New audio will use the configured default voice.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to remove the local voice.";
      notify(message);
      throw error;
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = async (patch: Partial<WorkspaceSettings>) => {
    setBusy("settings:save");
    try {
      const payload = await requestJson<{ state: DashboardState }>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setState(payload.state);
      notify("Configuration saved.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to save configuration.");
    } finally {
      setBusy(null);
    }
  };

  const selectVoice = async (voiceId: string) => {
    setBusy("voice:select");
    try {
      const payload = await requestJson<{ state: DashboardState }>(`/api/voices/${encodeURIComponent(voiceId)}`, {
        method: "PATCH",
      });
      setState(payload.state);
      notify("Primary narrator updated.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to select the local narrator.");
    } finally {
      setBusy(null);
    }
  };

  const feedUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/feed.xml`
      : "/feed.xml";

  const shellView = view === "review" || view === "create" ? "dashboard" : view;

  return (
    <>
      <OrganicAppShell
        view={shellView}
        onNavigate={navigate}
        onNewBriefing={() => navigate("create")}
        pageTitle={pageTitles[view === "review" || view === "create" ? shellView : view]}
        showFab={view === "dashboard"}
        onFabClick={() => digest && previewEpisode(digest)}
        onFooterAction={(label) => notify(`${label} is not configured for this local workspace yet.`)}
        footerYear={footerYear}
      >
        {view === "dashboard" && (
          <OrganicDashboardView
            state={state}
            digest={digest}
            onReview={() => navigate(digest ? "review" : "create")}
            onViewTranscription={() => navigate(digest ? "review" : "create")}
            onViewHistory={() => navigate("published")}
            onPreview={() => digest && previewEpisode(digest)}
          />
        )}
        {view === "published" && (
          <OrganicPublishedView
            episodes={state.episodes}
            onNewBriefing={() => navigate("create")}
            onReview={(episode) => { setView("review"); setState((current) => ({ ...current, episodes: current.episodes.map((candidate) => candidate.id === episode.id ? episode : candidate) })); }}
            onPreview={previewEpisode}
          />
        )}
        {view === "sources" && (
          <OrganicSourcesView
            state={state}
            onAddSource={() => setModal("source")}
            onAddInterest={() => setModal("interest")}
            onRefreshSource={async (sourceId) => {
              setBusy(`source:${sourceId}`);
              try {
                const payload = await requestJson<{ imported: number; state: DashboardState }>(`/api/sources/${encodeURIComponent(sourceId)}/refresh`, { method: "POST" });
                setState(payload.state);
                notify(`Imported ${payload.imported} item${payload.imported === 1 ? "" : "s"}.`);
              } catch (error) { notify(error instanceof Error ? error.message : "Unable to refresh source."); }
              finally { setBusy(null); }
            }}
            onOpenSource={(url) => window.open(url, "_blank", "noopener,noreferrer")}
            busy={busy}
            onRemoveInterest={async (interestId) => {
              try {
                const payload = await requestJson<{ state: DashboardState }>(`/api/interests/${encodeURIComponent(interestId)}`, { method: "DELETE" });
                setState(payload.state);
                notify("Interest removed.");
              } catch (error) { notify(error instanceof Error ? error.message : "Unable to remove interest."); }
            }}
          />
        )}
        {view === "settings" && <OrganicSettingsView state={state} feedUrl={feedUrl} onDeleteWorkspace={() => void deleteWorkspace()} busy={busy !== null} onNotify={notify} onCreateVoice={createVoice} onDisconnectVoice={disconnectVoice} onSaveSettings={saveSettings} onSelectVoice={selectVoice} />}
        {view === "review" && reviewEpisode && (
          <OrganicReviewView
            state={state}
            episode={reviewEpisode}
            playingId={playingId}
            onBack={() => navigate("dashboard")}
            onApprove={() => void approveEpisode(reviewEpisode.id)}
            onReject={() => void generateEpisode(reviewEpisode.type)}
            onPreview={() => previewEpisode(reviewEpisode)}
            onSeek={seekEpisode}
            onEdit={(script) => void editEpisode(reviewEpisode.id, script)}
            onRegenerateAudio={() => void regenerateEpisodeAudio(reviewEpisode.id)}
            onExport={() => exportEpisode(reviewEpisode)}
            busy={busy}
          />
        )}
        {view === "create" && (
          <OrganicCreateView
            state={state}
            onBack={() => navigate("dashboard")}
            onStart={(itemIds, episodeLength) => void generateEpisode("daily_digest", itemIds, episodeLength)}
            onAddSource={() => setModal("source")}
            busy={busy}
          />
        )}
      </OrganicAppShell>

      {modal && (
        <ModalPanel
          modal={modal}
          close={() => setModal(null)}
          setState={setState}
          notify={notify}
        />
      )}
      {toast && (
        <div className="organic-toast" role="status">
          {toast}
        </div>
      )}
    </>
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
        const payload = await requestJson<{ state: DashboardState }>("/api/interests", {
          method: "POST",
          body: JSON.stringify({
            name,
            query,
            keywords: keywords.split(",").map((v) => v.trim()).filter(Boolean),
            freshnessDays: 30,
            weight: 1,
          }),
        });
        setState(payload.state);
        notify(`Now tracking ${name}.`);
      } else {
        const payload = await requestJson<{ state: DashboardState }>("/api/sources", {
          method: "POST",
          body: JSON.stringify({ name, url }),
        });
        setState(payload.state);
        notify("Trusted feed added.");
      }
      close();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="organic-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section className="organic-modal" role="dialog" aria-modal="true">
        <button type="button" className="organic-modal-close" onClick={close} aria-label="Close">
          ×
        </button>
        <h2>{modal === "interest" ? "Track a research interest" : "Add a trusted feed"}</h2>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>{modal === "interest" ? "Interest name" : "Source name"}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required={modal === "interest"}
            />
          </label>
          {modal === "interest" ? (
            <>
              <label>
                <span>What should we look for?</span>
                <textarea value={query} onChange={(e) => setQuery(e.target.value)} required />
              </label>
              <label>
                <span>Keywords (comma-separated)</span>
                <input value={keywords} onChange={(e) => setKeywords(e.target.value)} />
              </label>
            </>
          ) : (
            <label>
              <span>RSS or Atom URL</span>
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
            </label>
          )}
          <div className="organic-modal-actions">
            <button type="button" className="organic-btn organic-btn-outline" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="organic-btn organic-btn-dark" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
