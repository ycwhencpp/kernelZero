"use client";

import type { DashboardState, Episode } from "../../lib/types";
import { formatDuration } from "../../lib/domain";

function statusForEpisode(episode: Episode): {
  label: string;
  tone: "published" | "processing" | "failed";
} {
  if (episode.status === "published" || episode.status === "approved") {
    return { label: "PUBLISHED", tone: "published" };
  }
  if (episode.status === "failed") {
    return { label: "FAILED", tone: "failed" };
  }
  if (episode.status === "generating") {
    return { label: "PROCESSING", tone: "processing" };
  }
  return { label: "NEEDS REVIEW", tone: "processing" };
}

function runMeta(episode: Episode): string {
  if (episode.status === "generating") return "Processing now";
  const created = new Date(episode.createdAt);
  return `Created ${created.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })}`;
}

export function OrganicDashboardView({
  state,
  digest,
  onReview,
  onViewTranscription,
  onViewHistory,
  onPreview,
}: {
  state: DashboardState;
  digest: Episode | undefined;
  onReview: (episode: Episode) => void;
  onViewTranscription: () => void;
  onViewHistory: () => void;
  onPreview: () => void;
}) {
  const recent = state.episodes.slice(0, 3);
  const digestStatus = digest ? statusForEpisode(digest) : null;
  const digestDate = digest
    ? new Date(digest.createdAt).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).toUpperCase()
    : "NO BRIEFING YET";
  const evidence = digest ? state.evidence.filter((claim) => claim.episodeId === digest.id) : [];
  const validConfidence = evidence
    .map((claim) => Number(claim.confidence))
    .filter((confidence) =>
      Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    );
  const evidenceConfidence = validConfidence.length
    ? `${Math.round((validConfidence.reduce((sum, confidence) => sum + confidence, 0) / validConfidence.length) * 100)}%`
    : "—";
  const month = new Date().toISOString().slice(0, 7);
  const monthlyEpisodes = state.episodes.filter((episode) => episode.createdAt.startsWith(month));

  return (
    <div className="organic-dashboard">
      <section className="organic-hero-grid">
        <article className="organic-hero-card">
          <img
            className="organic-hero-pattern"
            src="/figma/icon-pattern.svg"
            alt=""
          />
          <div className="organic-hero-body">
            <div className="organic-hero-meta">
              <span className="organic-pill organic-pill-lime">
                <i className="organic-dot" />
                {digestStatus?.label ?? "NO EPISODE"}
              </span>
              <span className="organic-eyebrow">{digestDate}</span>
            </div>
            <h3 className="organic-hero-title">
              {digest?.title ?? "No briefing generated yet"}
            </h3>
            <p className="organic-hero-dek">
              {digest?.dek ?? "Add an interest, discover sources, and generate your first evidence-checked briefing."}
            </p>
          </div>
          <div className="organic-hero-actions">
            <button
              type="button"
              className="organic-btn organic-btn-dark"
              disabled={!digest}
              onClick={() => digest && onReview(digest)}
            >
              Open Latest Episode
              <img src="/figma/icon-arrow.svg" alt="" width={10} height={10} />
            </button>
            <button
              type="button"
              className="organic-btn organic-btn-outline"
              onClick={onViewTranscription}
            >
              View Transcription
            </button>
          </div>
        </article>

        <div className="organic-hero-side">
          <div className="organic-meta-card">
            <p className="organic-eyebrow">METADATA</p>
            <dl className="organic-meta-list">
              <div>
                <dt>Estimated Length</dt>
                <dd>{digest ? formatDuration(digest.durationSeconds) : "14:22"}</dd>
              </div>
              <div>
                <dt>Evidence Confidence</dt>
                <dd>{evidenceConfidence}</dd>
              </div>
              <div>
                <dt>Sources Cited</dt>
                <dd>{digest?.citations.length ?? 0}</dd>
              </div>
            </dl>
          </div>
          <button
            type="button"
            className="organic-audio-preview"
            onClick={onPreview}
            aria-label="Preview audio waveform"
          >
            <img src="/figma/mic-preview.jpg" alt="" />
            <span>Preview Audio Waveform</span>
          </button>
        </div>
      </section>

      <section className="organic-lower-grid">
        <div className="organic-runs">
          <div className="organic-section-head">
            <h3>Recent Runs</h3>
            <button type="button" className="organic-text-link" onClick={onViewHistory}>
              View History
            </button>
          </div>
          <ul className="organic-run-list">
            {recent.map((episode) => {
              const status = statusForEpisode(episode);
              return (
                <li key={episode.id}>
                  <button
                    type="button"
                    className="organic-run-row"
                    onClick={() => onReview(episode)}
                    aria-label={`Review ${episode.title}`}
                  >
                  <div className="organic-run-main">
                    <span className={`organic-run-icon tone-${status.tone}`}>
                      <img
                        src={
                          status.tone === "published"
                            ? "/figma/icon-check.svg"
                            : status.tone === "failed"
                              ? "/figma/icon-error.svg"
                              : "/figma/icon-spinner.svg"
                        }
                        alt=""
                        width={20}
                        height={20}
                      />
                    </span>
                    <div>
                      <strong>{episode.title}</strong>
                      <small>{runMeta(episode)}</small>
                    </div>
                  </div>
                  <div className="organic-run-end">
                    <span className={`organic-status organic-status-${status.tone}`}>
                      {status.label}
                    </span>
                    <img src="/figma/icon-kebab.svg" alt="" width={4} height={16} />
                  </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="organic-bento">
          <div className="organic-stat-dark">
            <p className="organic-eyebrow light">MONTHLY OUTPUT</p>
            <strong className="organic-stat-big">{monthlyEpisodes.length}</strong>
            <p className="organic-stat-delta">Episodes created this month</p>
            <div className="organic-mini-bars" aria-hidden="true">
              {state.jobs.slice(0, 6).reverse().map((job, i) => (
                (() => {
                  const height = job.status === "completed" ? 18 + Math.min(28, Math.round((job.costUsd + 0.1) * 40)) : 12;
                  return (
                <i key={i} style={{ height: `${height}px` }} className={i === 5 ? "active" : ""} />
                  );
                })()
              ))}
            </div>
          </div>
          <div className="organic-stat-light">
            <p className="organic-eyebrow">SOURCES</p>
            <strong>{state.sources.length.toLocaleString()}</strong>
          </div>
          <div className="organic-stat-light">
            <p className="organic-eyebrow">PUBLISHED MINUTES</p>
            <strong>{state.stats.listeningMinutes}m</strong>
          </div>
        </div>
      </section>
    </div>
  );
}
