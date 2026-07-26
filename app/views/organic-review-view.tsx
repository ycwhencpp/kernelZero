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
  onBack,
  onApprove,
  onReject,
  onPreview,
  onSeek,
  onEdit,
  onRegenerateAudio,
  onExport,
  busy,
}: {
  state: DashboardState;
  episode: Episode;
  playingId: string | null;
  onBack: () => void;
  onApprove: () => void;
  onReject: () => void;
  onPreview: () => void;
  onSeek: (seconds: number) => void;
  onEdit: (script: string) => void;
  onRegenerateAudio: () => void;
  onExport: () => void;
  busy: string | null;
}) {
  const evidence = state.evidence.filter((claim) => claim.episodeId === episode.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(episode.script);
  const paragraphs = episode.script.split(/\n{2,}/);

  return (
    <div className="organic-review">
      <header className="organic-review-top">
        <button type="button" className="organic-text-link" onClick={onBack}>
          ← Back to Dashboard
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
        <span className="organic-eyebrow">DRAFT: NEEDS REVIEW</span>
        <p className="organic-eyebrow">
          EPISODE #{episode.generation} • {titleCase(episode.type)}
        </p>
        <h1>{episode.title}</h1>
        <div className="organic-review-stats">
          <span>⏱ {formatDuration(episode.durationSeconds)} min duration</span>
          <span>📄 {episode.citations.length} Sources cited</span>
        </div>
        <div className="organic-review-actions">
          <button type="button" className="organic-btn organic-btn-outline" onClick={onReject}>
            Reject / Redo
          </button>
          <button type="button" className="organic-btn organic-btn-outline" disabled={busy !== null} onClick={onRegenerateAudio}>
            Regenerate Audio
          </button>
          <button
            type="button"
            className="organic-btn organic-btn-lime"
            disabled={busy !== null}
            onClick={onApprove}
          >
            Approve and Publish
          </button>
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
            <button type="button" className="organic-text-link lime" onClick={() => { setDraft(episode.script); setEditing((value) => !value); }}>
              {editing ? "Cancel Edit" : "Edit Text"}
            </button>
          </div>
          {editing ? (
            <div className="organic-transcript-body">
              <textarea className="organic-input" value={draft} onChange={(event) => setDraft(event.target.value)} rows={18} />
              <button type="button" className="organic-btn organic-btn-dark" disabled={busy !== null || !draft.trim()} onClick={() => { onEdit(draft); setEditing(false); }}>Save Text</button>
            </div>
          ) : <div className="organic-transcript-body">{paragraphs.map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 24)}`}>{paragraph}</p>)}</div>}
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
              <p>AI is verifying additional sources…</p>
            </div>
          )}
        </aside>
      </div>

      <footer className="organic-player-bar">
        <div className="organic-player-meta">
          <span className="organic-episode-thumb">SC</span>
          <span>
            <strong>{episode.title.slice(0, 28)}</strong>
            <small>NOW REVIEWING</small>
          </span>
        </div>
        <div className="organic-player-controls">
          <button type="button" aria-label="Back 10 seconds" onClick={() => onSeek(-10)}>
            ↺10
          </button>
          <button type="button" className="organic-play" onClick={onPreview} aria-label="Play">
            {playingId === episode.id ? "Ⅱ" : "▶"}
          </button>
          <button type="button" aria-label="Forward 10 seconds" onClick={() => onSeek(10)}>
            10↻
          </button>
          <span>{formatDuration(0)}</span>
          <span>{formatDuration(episode.durationSeconds)}</span>
        </div>
        <button type="button" className="organic-btn organic-btn-light" onClick={onExport}>
          Final Export
        </button>
      </footer>
    </div>
  );
}
