"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppUser, DashboardState, Episode, EpisodeLength, WorkspaceSettings } from "../lib/types";
import {
  OrganicAppShell,
  type OrganicView,
} from "./components/organic/app-shell";
import { OrganicDashboardView } from "./views/organic-dashboard-view";
import { OrganicHistoryView } from "./views/organic-history-view";
import { OrganicPublishedView } from "./views/organic-published-view";
import { OrganicSourcesView } from "./views/organic-sources-view";
import { OrganicSettingsView } from "./views/organic-settings-view";
import { OrganicReviewView } from "./views/organic-review-view";
import { OrganicCreateView } from "./views/organic-create-view";
import { OrganicProfileView } from "./views/organic-profile-view";
import {
  clampPlaybackSeconds,
  PLAYBACK_RATES,
} from "../lib/playback";
import {
  reconcileGeneratedEpisode,
  requireGeneratedAudio,
} from "../lib/generated-episode";
import { buildRegenerateEpisodeRequest } from "../lib/podcast-regeneration";

type Modal = "interest" | "source" | null;
type AudioStatus = "missing" | "loading" | "ready" | "error";

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
  explore: "Explore Podcasts",
  history: "Run History",
  published: "My Published Episodes",
  sources: "Manage Sources",
  settings: "Settings",
  profile: "Account Settings",
  review: "",
  create: "",
};

const viewRoutes: Partial<Record<OrganicView, string>> = {
  dashboard: "/dashboard",
  history: "/history",
  published: "/published",
  sources: "/sources",
  settings: "/settings",
  profile: "/profile",
  create: "/create",
};

function pushClientRoute(route: string) {
  const currentRoute = `${window.location.pathname}${window.location.search}`;
  if (currentRoute !== route) {
    window.history.pushState(null, "", route);
  }
}

function clientRouteFromUrl(url: URL): {
  view: OrganicView;
  episodeId?: string;
  reviewReturnView?: OrganicView;
} | null {
  const pathname =
    url.pathname.length > 1
      ? url.pathname.replace(/\/+$/, "")
      : url.pathname;
  const viewEntry = Object.entries(viewRoutes).find(
    ([, route]) => route === pathname,
  );
  if (viewEntry) {
    return { view: viewEntry[0] as OrganicView };
  }

  const reviewMatch = pathname.match(/^\/review\/([^/]+)$/);
  if (!reviewMatch) return null;

  let episodeId: string;
  try {
    episodeId = decodeURIComponent(reviewMatch[1]);
  } catch {
    return null;
  }
  if (!episodeId) return null;

  const from = url.searchParams.get("from");
  const reviewReturnView: OrganicView =
    from === "history" || from === "published" ? from : "dashboard";
  return { view: "review", episodeId, reviewReturnView };
}

export function DashboardClient({
  initialState,
  user: initialUser,
  initialView,
  initialEpisodeId = null,
  initialReviewReturnView = "dashboard",
}: {
  initialState: DashboardState;
  user: AppUser;
  initialView: OrganicView;
  initialEpisodeId?: string | null;
  initialReviewReturnView?: OrganicView;
}) {
  const [state, setState] = useState(initialState);
  const [user, setUser] = useState(initialUser);
  const [view, setView] = useState<OrganicView>(initialView);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(
    initialEpisodeId,
  );
  const [reviewReturnView, setReviewReturnView] =
    useState<OrganicView>(initialReviewReturnView);
  const [playbackSeconds, setPlaybackSeconds] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [audioStatus, setAudioStatus] = useState<AudioStatus>("missing");
  const [footerYear] = useState(() => new Date().getFullYear());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canEdit = user.role === "owner" || user.role === "editor";
  const canPublish = user.role === "owner";
  const pendingSeekRef = useRef<{
    episodeId: string;
    seconds: number;
  } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const digest = useMemo(
    () =>
      state.episodes.find((e) => e.type === "daily_digest") ?? state.episodes[0],
    [state.episodes],
  );

  const reviewEpisode = useMemo(() => {
    return (
      state.episodes.find((episode) => episode.id === selectedEpisodeId) ??
      state.episodes.find((e) => e.status === "needs_approval") ??
      digest ??
      state.episodes[0]
    );
  }, [state.episodes, selectedEpisodeId, digest]);

  const notify = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };

  const updatePlaybackPosition = (seconds: number) => {
    setPlaybackSeconds(seconds);
  };

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      audio?.pause();
    };
  }, []);

  const navigate = (next: OrganicView) => {
    if (next === "explore") {
      window.location.assign("/explore");
      return;
    }
    if (next === "create" && !canEdit) {
      notify("Your viewer role has read-only workspace access.");
      return;
    }
    if (next === "settings" && user.role !== "owner") {
      notify("Only the workspace owner can manage settings.");
      return;
    }
    setView(next);
    const route = viewRoutes[next];
    if (route) pushClientRoute(route);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openReview = (episode: Episode, returnView: OrganicView = view) => {
    audioRef.current?.pause();
    if (audioRef.current?.dataset.episodeId === episode.id) {
      audioRef.current.currentTime = 0;
    }
    pendingSeekRef.current = null;
    updatePlaybackPosition(0);
    setPlaybackDuration(0);
    setAudioStatus(episode.audioUrl ? "loading" : "missing");
    setSelectedEpisodeId(episode.id);
    const nextReturnView =
      returnView === "review" || returnView === "create"
        ? "dashboard"
        : returnView;
    setReviewReturnView(nextReturnView);
    setView("review");
    pushClientRoute(
      `/review/${encodeURIComponent(episode.id)}?from=${encodeURIComponent(nextReturnView)}`,
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (episode.audioUrl) loadEpisodeAudio(episode);
  };

  const generateEpisode = async (
    type: Episode["type"],
    itemIds: string[] = [],
    episodeLength?: EpisodeLength,
    regeneration?: {
      episode: Episode;
      currentDraft: string;
    },
  ) => {
    setBusy(
      regeneration
        ? `regenerate:${regeneration.episode.id}`
        : `generate:${itemIds[0] ?? type}`,
    );
    try {
      const requestBody = regeneration
        ? buildRegenerateEpisodeRequest(
            state,
            regeneration.episode,
            regeneration.currentDraft,
          )
        : { type, itemIds, includeAudio: true, episodeLength };
      const payload = await requestJson<{
        episode: Episode;
        provider: "openai" | "gemini" | "ollama";
        state: DashboardState;
      }>("/api/generate", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });
      const generated = reconcileGeneratedEpisode(
        payload.state,
        payload.episode,
      );
      requireGeneratedAudio(generated.episode, requestBody.includeAudio);
      setState(generated.state);
      setSelectedEpisodeId(generated.episode.id);
      setReviewReturnView("dashboard");
      updatePlaybackPosition(0);
      setPlaybackDuration(0);
      setAudioStatus(generated.episode.audioUrl ? "loading" : "missing");
      setView("review");
      pushClientRoute(
        `/review/${encodeURIComponent(generated.episode.id)}?from=dashboard`,
      );
      if (generated.episode.audioUrl) loadEpisodeAudio(generated.episode);
      notify(
        regeneration
          ? "Draft regenerated from the current version and is ready for review."
          : "Evidence-checked script and local audio are ready for review.",
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
      pushClientRoute("/published");
      notify("Episode approved and queued for the public feed.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Approval failed.");
    } finally {
      setBusy(null);
    }
  };

  const loadEpisodeAudio = (episode: Episode): HTMLAudioElement | null => {
    if (!episode.audioUrl) return null;
    const audio = audioRef.current;
    if (!audio) return null;
    if (
      audio.dataset.episodeId !== episode.id ||
      audio.getAttribute("src") !== episode.audioUrl
    ) {
      audio.pause();
      setAudioStatus("loading");
      audio.src = episode.audioUrl;
      audio.dataset.episodeId = episode.id;
      audio.preload = "auto";
      audio.defaultPlaybackRate = playbackRate;
      audio.playbackRate = playbackRate;

      const applyPendingSeek = () => {
        const pending = pendingSeekRef.current;
        if (
          pending?.episodeId !== episode.id ||
          audio.readyState < 1
        ) {
          return;
        }
        const duration =
          Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : episode.durationSeconds;
        const target = Math.max(0, Math.min(duration, pending.seconds));
        if (Math.abs(audio.currentTime - target) < 0.25) {
          pendingSeekRef.current = null;
          updatePlaybackPosition(audio.currentTime);
          return;
        }
        try {
          audio.currentTime = target;
          updatePlaybackPosition(target);
        } catch {
          // Some browsers need canplay before accepting a seek.
        }
      };
      const updateDuration = () => {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
        setPlaybackDuration(audio.duration);
        setAudioStatus("ready");
        applyPendingSeek();
      };
      audio.onloadedmetadata = updateDuration;
      audio.ondurationchange = updateDuration;
      audio.oncanplay = applyPendingSeek;
      audio.onplaying = applyPendingSeek;
      audio.onplay = () => setPlayingId(episode.id);
      audio.onpause = () => {
        if (!audio.ended) setPlayingId(null);
      };
      audio.ontimeupdate = () => {
        const pending = pendingSeekRef.current;
        if (pending?.episodeId === episode.id) {
          if (Math.abs(audio.currentTime - pending.seconds) < 0.75) {
            pendingSeekRef.current = null;
          } else {
            return;
          }
        }
        updatePlaybackPosition(audio.currentTime);
      };
      audio.onseeked = () => {
        const pending = pendingSeekRef.current;
        if (
          pending?.episodeId === episode.id &&
          Math.abs(audio.currentTime - pending.seconds) < 0.75
        ) {
          pendingSeekRef.current = null;
        } else if (pending?.episodeId === episode.id) {
          applyPendingSeek();
          return;
        }
        updatePlaybackPosition(audio.currentTime);
      };
      audio.onended = () => {
        updatePlaybackPosition(audio.duration || episode.durationSeconds);
        setPlayingId(null);
      };
      audio.onerror = () => {
        setPlayingId(null);
        setAudioStatus("error");
        notify("Stored audio could not be loaded.");
      };
      updatePlaybackPosition(0);
      setPlaybackDuration(0);
      audio.load();
    } else if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setPlaybackDuration(audio.duration);
      setAudioStatus("ready");
    }
    return audio;
  };
  const loadEpisodeAudioRef = useRef(loadEpisodeAudio);
  useEffect(() => {
    loadEpisodeAudioRef.current = loadEpisodeAudio;
  });

  useEffect(() => {
    const syncViewFromHistory = () => {
      const route = clientRouteFromUrl(new URL(window.location.href));
      if (!route) return;

      const audio = audioRef.current;
      audio?.pause();
      pendingSeekRef.current = null;
      setPlayingId(null);
      updatePlaybackPosition(0);
      setPlaybackDuration(0);

      if (route.view === "review" && route.episodeId) {
        const episode = state.episodes.find(
          (candidate) => candidate.id === route.episodeId,
        );
        if (!episode) {
          setSelectedEpisodeId(null);
          setAudioStatus("missing");
          setView("history");
          window.history.replaceState(null, "", "/history");
          window.scrollTo({ top: 0 });
          return;
        }
        setSelectedEpisodeId(route.episodeId);
        setReviewReturnView(route.reviewReturnView ?? "dashboard");
        setAudioStatus(episode.audioUrl ? "loading" : "missing");
        if (audio) {
          audio.removeAttribute("src");
          delete audio.dataset.episodeId;
          audio.load();
        }
        if (episode.audioUrl) loadEpisodeAudioRef.current(episode);
      }

      setView(route.view);
      window.scrollTo({ top: 0 });
    };

    window.addEventListener("popstate", syncViewFromHistory);
    return () => window.removeEventListener("popstate", syncViewFromHistory);
  }, [state.episodes]);

  const previewEpisode = (episode: Episode) => {
    if (!episode.audioUrl) {
      notify("This run has no audio file. Generate audio from the Review page.");
      return;
    }
    const audio = loadEpisodeAudio(episode);
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    void audio.play().catch(() =>
      notify("Stored audio could not be played."),
    );
  };

  const seekEpisode = (episode: Episode, delta: number) => {
    if (!episode.audioUrl) return;
    const pending = pendingSeekRef.current;
    const currentSeconds =
      pending?.episodeId === episode.id
        ? pending.seconds
        : audioRef.current?.dataset.episodeId === episode.id
          ? audioRef.current.currentTime
          : playbackSeconds;
    seekEpisodeTo(episode, currentSeconds + delta);
  };

  const seekEpisodeTo = (episode: Episode, seconds: number) => {
    if (!episode.audioUrl) return;

    const audio = loadEpisodeAudio(episode);
    const duration =
      audio && Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : playbackDuration || episode.durationSeconds;
    const target = clampPlaybackSeconds(seconds, duration);
    if (!audio) {
      updatePlaybackPosition(target);
      return;
    }

    pendingSeekRef.current = { episodeId: episode.id, seconds: target };
    if (audio.readyState >= 1) {
      try {
        if (Math.abs(audio.currentTime - target) < 0.25) {
          pendingSeekRef.current = null;
        } else {
          audio.currentTime = target;
        }
      } catch {
        // The loadedmetadata/canplay handlers will retry this seek.
      }
    } else {
      audio.load();
    }
    updatePlaybackPosition(target);
  };

  const changePlaybackRate = (rate: number) => {
    const nextRate = PLAYBACK_RATES.includes(
      rate as (typeof PLAYBACK_RATES)[number],
    )
      ? rate
      : 1;
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.defaultPlaybackRate = nextRate;
      audioRef.current.playbackRate = nextRate;
    }
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
    const hadAudio = Boolean(
      state.episodes.find((episode) => episode.id === episodeId)?.audioUrl,
    );
    setBusy(`audio:${episodeId}`);
    setAudioStatus("loading");
    try {
      const payload = await requestJson<{
        episode: Episode;
        state: DashboardState;
      }>(`/api/episodes/${encodeURIComponent(episodeId)}/audio`, {
        method: "POST",
      });
      const generated = reconcileGeneratedEpisode(
        payload.state,
        payload.episode,
      );
      requireGeneratedAudio(generated.episode, true);
      setState(generated.state);
      loadEpisodeAudio(generated.episode);
      notify(
        hadAudio
          ? "Audio regenerated with the selected local narrator."
          : "Audio generated with the selected local narrator.",
      );
    } catch (error) {
      setAudioStatus(hadAudio ? "error" : "missing");
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
      pushClientRoute("/dashboard");
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

  const shellView =
    view === "review"
      ? reviewReturnView
      : view === "create"
        ? "dashboard"
        : view;

  return (
    <>
      <audio ref={audioRef} preload="auto" hidden aria-hidden="true" />
      <OrganicAppShell
        view={shellView}
        onNavigate={navigate}
        onNewBriefing={() => navigate("create")}
        pageTitle={pageTitles[shellView]}
        showFab={view === "dashboard"}
        onFabClick={() => digest && previewEpisode(digest)}
        onFooterAction={(label) => notify(`${label} is not configured for this local workspace yet.`)}
        footerYear={footerYear}
        immersive={view === "review" || view === "create"}
        user={user}
        canCreate={canEdit}
      >
        {view === "dashboard" && (
          <OrganicDashboardView
            state={state}
            digest={digest}
            onReview={(episode) => openReview(episode, "dashboard")}
            onViewTranscription={() =>
              digest ? openReview(digest, "dashboard") : navigate("create")
            }
            onViewHistory={() => navigate("history")}
            onPreview={() => digest && previewEpisode(digest)}
          />
        )}
        {view === "history" && (
          <OrganicHistoryView
            episodes={state.episodes}
            canCreate={canEdit}
            onNewBriefing={() => navigate("create")}
            onReview={(episode) => openReview(episode, "history")}
            onPreview={previewEpisode}
          />
        )}
        {view === "published" && (
          <OrganicPublishedView
            episodes={state.episodes}
            canCreate={canEdit}
            onNewBriefing={() => navigate("create")}
            onReview={(episode) => openReview(episode, "published")}
            onPreview={previewEpisode}
          />
        )}
        {view === "sources" && (
          <OrganicSourcesView
            state={state}
            canEdit={canEdit}
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
        {view === "profile" && (
          <OrganicProfileView
            user={user}
            onUserUpdate={setUser}
            onNotify={notify}
          />
        )}
        {view === "review" && reviewEpisode && (
          <OrganicReviewView
            key={reviewEpisode.id}
            state={state}
            episode={reviewEpisode}
            playingId={playingId}
            playbackSeconds={playbackSeconds}
            playbackDuration={playbackDuration}
            playbackRate={playbackRate}
            audioStatus={audioStatus}
            backLabel={
              reviewReturnView === "history"
                ? "History"
                : reviewReturnView === "published"
                  ? "Published"
                  : "Dashboard"
            }
            onBack={() => navigate(reviewReturnView)}
            onApprove={() => void approveEpisode(reviewEpisode.id)}
            canEdit={canEdit}
            canPublish={canPublish}
            user={user}
            onRegenerateDraft={(currentDraft) =>
              void generateEpisode(
                reviewEpisode.type,
                [],
                state.settings.episodeLength,
                { episode: reviewEpisode, currentDraft },
              )
            }
            onPreview={() => previewEpisode(reviewEpisode)}
            onSeek={(delta) => seekEpisode(reviewEpisode, delta)}
            onSeekTo={(seconds) => seekEpisodeTo(reviewEpisode, seconds)}
            onPlaybackRateChange={changePlaybackRate}
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
