"use client";

import { useState } from "react";
import type { DashboardState, Episode } from "../../lib/types";
import { formatDuration } from "../../lib/domain";

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

export function OrganicReviewView({
  state,
  episode,
  playingId,
  playbackSeconds,
  playbackDuration,
  playbackRate,
  audioStatus,
  backLabel,
  onBack,
  onApprove,
  onRegenerateDraft,
  onPreview,
  onSeek,
  onSeekTo,
  onPlaybackRateChange,
  onEdit,
  onRegenerateAudio,
  onExport,
  busy,
}: {
  state: DashboardState;
  episode: Episode;
  playingId: string | null;
  playbackSeconds: number;
  playbackDuration: number;
  playbackRate: number;
  audioStatus: "missing" | "loading" | "ready" | "error";
  backLabel: string;
  onBack: () => void;
  onApprove: () => void;
  onRegenerateDraft: (currentDraft: string) => void;
  onPreview: () => void;
  onSeek: (seconds: number) => void;
  onSeekTo: (seconds: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  onEdit: (script: string) => void;
  onRegenerateAudio: () => void;
  onExport: () => void;
  busy: string | null;
}) {
  const evidence = state.evidence.filter((claim) => claim.episodeId === episode.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(episode.script);
  const paragraphs = episode.script.split(/\n{2,}/).filter(Boolean);
  const hasAudio = Boolean(episode.audioUrl);
  const audioReady = hasAudio && audioStatus === "ready";
  const duration = audioReady ? Math.max(1, playbackDuration) : 0;
  const rawChapters = episode.chapters.length
    ? episode.chapters
    : paragraphs.map((_, index) => ({
        title: `Section ${index + 1}`,
        startSeconds: Math.round(
          (episode.durationSeconds * index) / Math.max(1, paragraphs.length),
        ),
      }));
  const chapterScale = audioReady
    ? duration / Math.max(1, episode.durationSeconds)
    : 1;
  const chapters = rawChapters.map((chapter) => ({
    ...chapter,
    startSeconds: Math.min(
      duration || episode.durationSeconds,
      chapter.startSeconds * chapterScale,
    ),
  }));
  const activeChapterIndex = chapters.reduce(
    (active, chapter, index) =>
      playbackSeconds >= chapter.startSeconds ? index : active,
    0,
  );
  const canEdit =
    episode.status === "needs_approval" || episode.status === "draft";
  const canApprove = episode.status === "needs_approval";
  const revealChapter = (seconds: number) => {
    if (audioReady) onSeekTo(seconds);
    const chapterIndex = chapters.reduce(
      (active, chapter, index) =>
        seconds >= chapter.startSeconds ? index : active,
      0,
    );
    document
      .getElementById(`review-section-${chapterIndex}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="organic-review">
      <header className="organic-review-top">
        <button type="button" className="organic-text-link" onClick={onBack}>
          ← Back to {backLabel}
        </button>
        <div className="organic-review-user">
          <span>
            <strong>Workspace producer</strong>
            <small>OWNER</small>
          </span>
          <img src="/figma/avatar.jpg" alt="" />
        </div>
      </header>

      <div className="organic-review-banner">
        <span className="organic-eyebrow">
          {episode.status === "needs_approval"
            ? "DRAFT: NEEDS REVIEW"
            : titleCase(episode.status)}
        </span>
        <p className="organic-eyebrow">
          EPISODE #{episode.generation} • {titleCase(episode.type)}
        </p>
        <h1>{episode.title}</h1>
        <div className="organic-review-stats">
          <span>
            {audioReady
              ? `${formatDuration(duration)} audio`
              : audioStatus === "loading"
                ? "Preparing audio"
                : audioStatus === "error"
                  ? "Audio unavailable"
                  : "No audio generated"}
          </span>
          <span>{episode.citations.length} sources cited</span>
          <span>{titleCase(episode.status)}</span>
        </div>
        <div className="organic-review-actions">
          <button
            type="button"
            className="organic-btn organic-btn-outline"
            disabled={busy !== null}
            onClick={() => onRegenerateDraft(editing ? draft : episode.script)}
          >
            Regenerate Draft
          </button>
          <button type="button" className="organic-btn organic-btn-outline" disabled={busy !== null || audioStatus === "loading"} onClick={onRegenerateAudio}>
            {audioStatus === "loading"
              ? "Generating Audio..."
              : hasAudio
                ? "Regenerate Audio"
                : "Generate Audio"}
          </button>
          {canApprove ? (
            <button
              type="button"
              className="organic-btn organic-btn-lime"
              disabled={busy !== null}
              onClick={onApprove}
            >
              Approve and Publish
            </button>
          ) : (
            <span className="organic-review-state">
              {titleCase(episode.status)}
            </span>
          )}
        </div>
        <div className="organic-citation-pills">
          {episode.citations.slice(0, 4).map((c) => (
            <span key={c.url}>{c.label || c.title}</span>
          ))}
          {episode.citations.length > 4 && (
            <span className="more">+{episode.citations.length - 4} More</span>
          )}
        </div>
      </div>

      <div className="organic-review-grid">
        <article className="organic-panel transcript">
          <div className="organic-panel-head">
            <h3>Transcript</h3>
            {canEdit && (
              <button type="button" className="organic-text-link lime" onClick={() => { setDraft(episode.script); setEditing((value) => !value); }}>
                {editing ? "Cancel Edit" : "Edit Text"}
              </button>
            )}
          </div>
          {editing ? (
            <div className="organic-transcript-body">
              <textarea className="organic-input" value={draft} onChange={(event) => setDraft(event.target.value)} rows={18} />
              <button type="button" className="organic-btn organic-btn-dark" disabled={busy !== null || !draft.trim()} onClick={() => { onEdit(draft); setEditing(false); }}>Save Text</button>
            </div>
          ) : (
            <div className="organic-transcript-body">
              {paragraphs.map((paragraph, index) => (
                <section
                  id={`review-section-${index}`}
                  className={`organic-transcript-section ${
                    index === activeChapterIndex ? "is-active" : ""
                  }`}
                  key={`${index}-${paragraph.slice(0, 24)}`}
                >
                  {chapters[index] && <h4>{chapters[index].title}</h4>}
                  <p>{paragraph}</p>
                </section>
              ))}
              {!paragraphs.length && (
                <p>No transcript was stored for this run.</p>
              )}
            </div>
          )}
        </article>

        <aside className="organic-panel evidence">
          <h3>Evidence &amp; Sources</h3>
          {evidence.map((claim) => (
            <article key={claim.id} className="organic-evidence-card">
              <p className="organic-kicker lime">DIRECT ATTRIBUTION</p>
              <h4>{claim.claim}</h4>
              <blockquote>{claim.support}</blockquote>
              <footer>
                <span>{claim.location}</span>
                <a href={claim.sourceUrl} target="_blank" rel="noreferrer">
                  View PDF Source
                </a>
              </footer>
            </article>
          ))}
          {evidence.length === 0 && (
            <div className="organic-evidence-card dashed">
              <p>No itemized evidence cards were stored for this run.</p>
            </div>
          )}
        </aside>
      </div>

      <footer className="organic-player-bar">
        <div className="organic-player-main">
          <div className="organic-player-meta">
            <span className="organic-episode-thumb">SC</span>
            <span>
              <strong>{episode.title.slice(0, 42)}</strong>
              <small>
                {audioReady
                  ? chapters[activeChapterIndex]?.title ?? "Now reviewing"
                  : audioStatus === "loading"
                    ? "Generating or loading audio"
                    : audioStatus === "error"
                      ? "Audio unavailable"
                      : "Generate audio to enable playback"}
              </small>
            </span>
          </div>
          <div className="organic-player-controls">
            {audioReady ? (
              <>
                <button type="button" aria-label="Back 10 seconds" onClick={() => onSeek(-10)}>
                  -10
                </button>
                <button
                  type="button"
                  className="organic-play"
                  onClick={onPreview}
                  aria-label={playingId === episode.id ? "Pause" : "Play"}
                >
                  {playingId === episode.id ? "II" : "▶"}
                </button>
                <button type="button" aria-label="Forward 10 seconds" onClick={() => onSeek(10)}>
                  +10
                </button>
                <select
                  className="organic-playback-rate"
                  aria-label="Playback speed"
                  value={playbackRate}
                  onChange={(event) =>
                    onPlaybackRateChange(Number(event.target.value))
                  }
                >
                  <option value={0.75}>0.75x</option>
                  <option value={1}>1x</option>
                  <option value={1.25}>1.25x</option>
                  <option value={1.5}>1.5x</option>
                  <option value={2}>2x</option>
                </select>
              </>
            ) : (
              <button
                type="button"
                className="organic-btn organic-btn-lime"
                disabled={busy !== null || audioStatus === "loading"}
                onClick={onRegenerateAudio}
              >
                {audioStatus === "loading"
                  ? "Generating Audio..."
                  : hasAudio
                    ? "Repair Audio"
                    : "Generate Audio"}
              </button>
            )}
          </div>
          <button type="button" className="organic-btn organic-btn-light" onClick={onExport}>
            Final Export
          </button>
        </div>
        <div className="organic-player-timeline">
          <span>{audioReady ? formatDuration(playbackSeconds) : "--:--"}</span>
          <div className="organic-player-track">
            <input
              type="range"
              min={0}
              max={Math.max(1, duration)}
              step={1}
              value={audioReady ? Math.min(playbackSeconds, duration) : 0}
              disabled={!audioReady}
              aria-label="Podcast position"
              onChange={(event) => revealChapter(Number(event.target.value))}
            />
            <div className="organic-chapter-markers" aria-hidden="true">
              {chapters.slice(1).map((chapter) => (
                <i
                  key={`${chapter.title}-${chapter.startSeconds}`}
                  style={{
                    left: `${Math.min(100, (chapter.startSeconds / duration) * 100)}%`,
                  }}
                />
              ))}
            </div>
          </div>
          <span>{audioReady ? formatDuration(duration) : "--:--"}</span>
        </div>
        <nav className="organic-player-chapters" aria-label="Podcast sections">
          {chapters.map((chapter, index) => (
            <button
              type="button"
              key={`${chapter.title}-${chapter.startSeconds}`}
              className={index === activeChapterIndex ? "is-active" : ""}
              onClick={() => revealChapter(chapter.startSeconds)}
            >
              <span>{index + 1}</span>
              {chapter.title}
            </button>
          ))}
        </nav>
      </footer>
    </div>
  );
}
