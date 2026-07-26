"use client";

import { useEffect, useState } from "react";
import type { DashboardState, VoiceProfile } from "../../lib/types";

const ACCEPTED_AUDIO = "audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/aac,audio/flac,audio/webm,audio/mp4";

async function durationSeconds(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : null);
      audio.onerror = () => resolve(null);
      audio.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function VoiceProfileSetup({
  voiceProfile,
  onCreateVoice,
  onDisconnectVoice,
  onNotify,
}: {
  voiceProfile: VoiceProfile | null;
  onCreateVoice: (form: FormData) => Promise<void>;
  onDisconnectVoice: () => Promise<void>;
  onNotify: (message: string) => void;
}) {
  const [name, setName] = useState(voiceProfile?.name ?? "");
  const [audioSample, setAudioSample] = useState<File | null>(null);
  const [consentAcknowledged, setConsentAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const previewVoice = async () => {
    if (audioSample) {
      const sampleDuration = await durationSeconds(audioSample);
      if (sampleDuration !== null && (sampleDuration <= 5 || sampleDuration > 30)) {
        onNotify("Use a clear recording between 6 and 30 seconds.");
        return;
      }
    } else if (!voiceProfile) {
      onNotify("Upload a sample or save a local voice before previewing.");
      return;
    }

    const form = new FormData();
    if (audioSample) {
      form.set("audioSample", audioSample);
      form.set("consentAcknowledged", String(consentAcknowledged));
    }
    setPreviewing(true);
    try {
      const response = await fetch("/api/voices/preview", { method: "POST", body: form });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || "Unable to generate the voice preview.");
      }
      const nextPreviewUrl = URL.createObjectURL(await response.blob());
      setPreviewUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return nextPreviewUrl;
      });
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Unable to generate the voice preview.");
    } finally {
      setPreviewing(false);
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!audioSample) {
      onNotify("Add a reference voice sample.");
      return;
    }
    const sampleDuration = await durationSeconds(audioSample);
    if (sampleDuration !== null && (sampleDuration <= 5 || sampleDuration > 30)) {
      onNotify("Use a clear recording between 6 and 30 seconds.");
      return;
    }
    const form = new FormData();
    form.set("name", name.trim());
    form.set("audioSample", audioSample);
    form.set("consentAcknowledged", String(consentAcknowledged));
    setBusy(true);
    try {
      await onCreateVoice(form);
      setAudioSample(null);
      setConsentAcknowledged(false);
    } catch {
      // The parent surfaces the upload or persistence error in the shared toast.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="organic-voice-setup">
      <div className="organic-voice-status">
        <div>
          <span>Custom narration voice</span>
          <strong>{voiceProfile ? `${voiceProfile.name} is active` : "Not configured"}</strong>
        </div>
        {voiceProfile && (
          <button
            type="button"
            className="organic-btn organic-btn-outline compact"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Remove this local voice reference from SignalCast? The uploaded sample will be deleted from this machine.")) {
                void (async () => {
                  setBusy(true);
                  try {
                    await onDisconnectVoice();
                  } catch {
                    // The parent surfaces the error in the shared toast.
                  } finally {
                    setBusy(false);
                  }
                })();
              }
            }}
          >
            Disconnect
          </button>
        )}
      </div>
      <p className="organic-voice-copy">
        The reference recording stays on this SignalCast machine. Supabase stores only a local file key,
        never the audio itself. It is used only after the speaker gives consent.
      </p>
      <form className="organic-voice-form" onSubmit={(event) => void submit(event)}>
        <label className="organic-field">
          <span>Voice name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={80} placeholder="e.g. Anurag Narration" />
        </label>
        <label className="organic-field">
          <span>Reference voice sample (6–30 seconds)</span>
          <small>Use a clear recording of the same speaker. MP3, WAV, OGG, AAC, FLAC, WebM, or MP4; 10 MB maximum.</small>
          <input type="file" accept={ACCEPTED_AUDIO} onChange={(event) => setAudioSample(event.target.files?.[0] ?? null)} required />
        </label>
        <label className="organic-checkbox-row">
          <input type="checkbox" checked={consentAcknowledged} onChange={(event) => setConsentAcknowledged(event.target.checked)} required />
          <span>I am the speaker, or I have the speaker’s explicit permission to create and use this voice.</span>
        </label>
        <div className="organic-voice-preview">
          <button
            type="button"
            className="organic-btn organic-btn-outline"
            disabled={busy || previewing || (Boolean(audioSample) && !consentAcknowledged) || (!audioSample && !voiceProfile)}
            onClick={() => void previewVoice()}
          >
            {previewing ? "Generating preview…" : audioSample ? "Preview selected voice" : "Preview active voice"}
          </button>
          {previewUrl && <audio controls src={previewUrl} />}
        </div>
        <button type="submit" className="organic-btn organic-btn-dark" disabled={busy || !consentAcknowledged}>
          {busy ? "Saving voice…" : voiceProfile ? "Replace local voice" : "Create local voice"}
        </button>
      </form>
      <p className="organic-voice-note">Uses local Chatterbox TTS. Ollama can continue to write and fact-check the podcast; no OpenAI key is needed.</p>
    </div>
  );
}

export function OrganicSettingsView({ state, feedUrl, onDeleteWorkspace, busy, onNotify, onCreateVoice, onDisconnectVoice }: { state: DashboardState; feedUrl: string; onDeleteWorkspace: () => void; busy: boolean; onNotify: (message: string) => void; onCreateVoice: (form: FormData) => Promise<void>; onDisconnectVoice: () => Promise<void> }) {
  const [dailyGeneration, setDailyGeneration] = useState(true);
  const [length, setLength] = useState("standard");
  const [publishTime, setPublishTime] = useState("08:00");
  const narrator = state.voiceProfile ? `${state.voiceProfile.name} — local Chatterbox voice` : "Local system voice";
  return (
    <div className="organic-settings">
      <div className="organic-settings-top">
        <div>
          <p className="organic-eyebrow">Pipeline Active</p>
          <h2 className="organic-settings-title">Configuration Pipeline</h2>
          <p className="organic-settings-sub">
            Manage briefing parameters, voice characteristics, and distribution endpoints for your
            workspace.
          </p>
        </div>
      </div>

      <div className="organic-settings-grid">
        <article className="organic-panel wide">
          <p className="organic-kicker">PRODUCTION ASSET</p>
          <div className="organic-settings-split">
            <div>
              <h3>
                AI Voice &amp; Persona <span className="organic-badge-hd">Neural HD</span>
              </h3>
              <label className="organic-field">
                <span>Primary Narrator</span>
                <input value={narrator} readOnly />
              </label>
              <div className="organic-segment">
                <span>Episode Length Strategy</span>
                <div className="organic-segment-row">
                  <button type="button" className={length === "brief" ? "is-active" : ""} onClick={() => setLength("brief")}>Brief (5m)</button>
                  <button type="button" className={length === "standard" ? "is-active" : ""} onClick={() => setLength("standard")}>
                    Standard (12m)
                  </button>
                  <button type="button" className={length === "deep" ? "is-active" : ""} onClick={() => setLength("deep")}>Deep (25m)</button>
                </div>
              </div>
            </div>
            <div className="organic-wave-preview">
              <span>{state.voiceProfile ? "Custom voice ready" : "Local voice preview"}</span>
              <div className="organic-wave-bars">
                {[12, 22, 18, 28, 16, 32, 24, 30].map((h, i) => (
                  <i key={i} style={{ height: `${h}px` }} />
                ))}
              </div>
            </div>
          </div>
          <VoiceProfileSetup voiceProfile={state.voiceProfile} onCreateVoice={onCreateVoice} onDisconnectVoice={onDisconnectVoice} onNotify={onNotify} />
        </article>

        <article className="organic-panel">
          <p className="organic-kicker">AUTOMATION</p>
          <h3>Briefing Schedule</h3>
          <div className="organic-toggle-row">
            <span>Daily Generation</span>
            <button type="button" className={`organic-toggle ${dailyGeneration ? "is-on" : ""}`} aria-pressed={dailyGeneration} onClick={() => setDailyGeneration((value) => !value)}>
              {dailyGeneration ? "ON" : "OFF"}
            </button>
          </div>
          <label className="organic-field">
            <span>Publish Time (EST)</span>
            <input type="time" value={publishTime} onChange={(event) => setPublishTime(event.target.value)} />
          </label>
          <div className="organic-callout">
            <span>Next Expected Output</span>
            <strong>{dailyGeneration ? "Enabled" : "Paused"}</strong>
          </div>
        </article>

        <article className="organic-panel">
          <p className="organic-kicker">DISTRIBUTION</p>
          <h3>Feed Endpoints</h3>
          <label className="organic-field">
            <span>Public RSS Feed</span>
            <div className="organic-copy-row">
              <input readOnly value={feedUrl} />
              <button type="button" className="organic-btn organic-btn-outline" onClick={() => { void navigator.clipboard?.writeText(feedUrl); onNotify("Feed URL copied."); }}>
                Copy
              </button>
            </div>
          </label>
          <div className="organic-platform-list">
            <div className="organic-platform active">
              <span>Spotify Podcast</span>
              <em>Active ✓</em>
            </div>
            <div className="organic-platform">
              <span>Apple Podcasts</span>
              <button type="button" onClick={() => onNotify("Apple Podcasts distribution requires a connected publisher account.")}>Connect</button>
            </div>
          </div>
        </article>

        <article className="organic-panel">
          <p className="organic-kicker">WORKSPACE</p>
          <div className="organic-panel-head"><h3>Workspace data</h3><span className="organic-pill organic-pill-lime small">LIVE</span></div>
          <p className="organic-panel-copy">{state.items.length} items, {state.episodes.length} episodes, and {state.jobs.length} recorded jobs are stored for this workspace.</p>
          <button type="button" className="organic-btn organic-btn-outline" onClick={() => onNotify("Workspace data is loaded directly from Supabase.")}>Check connection</button>
        </article>
      </div>

      <article className="organic-danger">
        <div>
          <h3>Danger Zone</h3>
          <p>Permanently delete this pipeline and all generated briefings. This cannot be undone.</p>
        </div>
        <button type="button" className="organic-btn organic-btn-danger" disabled={busy} onClick={onDeleteWorkspace}>
          {busy ? "Deleting…" : "Delete Pipeline"}
        </button>
      </article>
    </div>
  );
}
