"use client";

import type { DashboardState } from "../../lib/types";

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function relativeTime(value: string | null): string {
  if (!value) return "Not scanned yet";
  const minutes = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `Scanned ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Scanned ${hours}h ago`;
  return `Scanned ${Math.round(hours / 24)}d ago`;
}

export function OrganicSourcesView({
  state,
  onAddSource,
  onAddInterest,
  onRefreshSource,
  onOpenSource,
  onRemoveInterest,
  busy,
  canEdit,
}: {
  state: DashboardState;
  canEdit: boolean;
  onAddSource: () => void;
  onAddInterest: () => void;
  onRefreshSource: (sourceId: string) => void;
  onOpenSource: (url: string) => void;
  onRemoveInterest: (interestId: string) => void;
  busy: string | null;
}) {
  const keywords = state.interests.flatMap((i) => i.keywords.map((keyword) => ({ keyword, interestId: i.id }))).slice(0, 12);

  return (
    <div className="organic-sources-page">
      {!canEdit && (
        <div className="organic-role-notice">
          Viewer access is read-only. An owner or editor can change sources and interests.
        </div>
      )}
      <header className="organic-sources-header">
        <h2 className="organic-page-title inline">Manage Sources</h2>
        <div className="organic-sources-header-actions">
          <button type="button" className="organic-text-link" onClick={() => window.open("https://github.com", "_blank", "noopener,noreferrer")}>
            Documentation
          </button>
          <button type="button" className="organic-text-link" onClick={() => window.open("https://status.openai.com", "_blank", "noopener,noreferrer")}>
            System Status
          </button>
          {canEdit && (
            <button type="button" className="organic-btn organic-btn-lime" onClick={onAddSource}>
              Add New Source
            </button>
          )}
        </div>
      </header>

      <div className="organic-sources-grid">
        <div className="organic-sources-col">
          <article className="organic-panel">
            <div className="organic-panel-head">
              <h3>Interests</h3>
              {canEdit && (
                <button type="button" className="organic-text-link lime" onClick={onAddInterest}>
                  Edit All
                </button>
              )}
            </div>
            <p className="organic-panel-copy">
              Define keywords and entities that KernelZero prioritizes across all monitors.
            </p>
            <div className="organic-tag-list">
              {keywords.map(({ keyword, interestId }) => (
                  <span key={`${interestId}-${keyword}`} className="organic-tag">
                    {keyword}
                    {canEdit && (
                      <button type="button" aria-label={`Remove ${keyword}`} onClick={() => onRemoveInterest(interestId)}>
                        ×
                      </button>
                    )}
                  </span>
                ))}
              {canEdit && (
                <button type="button" className="organic-tag-add" onClick={onAddInterest}>
                  + Add Topic
                </button>
              )}
            </div>
          </article>

          <article className="organic-insight-card">
            <p className="organic-eyebrow lime">SYSTEM INSIGHT</p>
            <h3>{state.stats.newToday ? `${state.stats.newToday} new item${state.stats.newToday === 1 ? "" : "s"} arrived today.` : "No new items have arrived today."}</h3>
          </article>
        </div>

        <div className="organic-source-feed">
          {state.sources.map((source) => {
            const healthy = Boolean(source.lastSuccessfulFetch);
            const error = !source.enabled;
            return (
              <article
                key={source.id}
                className={`organic-source-card ${error ? "is-error" : ""}`}
              >
                <div className="organic-source-main">
                  <span className="organic-source-icon">{source.name.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <p className="organic-source-kind">{titleCase(source.type)}</p>
                    <h4>{source.name}</h4>
                    <div className="organic-source-meta">
                      <span
                        className={`organic-source-badge ${healthy ? "active" : error ? "error" : "pending"}`}
                      >
                        {error ? "CONNECTION ERROR" : healthy ? "ACTIVE" : "PROCESSING"}
                      </span>
                      <span>
                        {healthy ? relativeTime(source.lastSuccessfulFetch) : error ? "Connection unavailable" : "Queued"}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="organic-source-actions">
                  {canEdit && (
                    <button type="button" aria-label="Refresh source" disabled={busy === `source:${source.id}`} onClick={() => onRefreshSource(source.id)}>
                      ↻
                    </button>
                  )}
                  <button type="button" aria-label="Open source" onClick={() => onOpenSource(source.url)}>
                    ✎
                  </button>
                </div>
              </article>
            );
          })}
          {state.sources.length === 0 && (
            <div className="organic-empty-panel">
              <p>No sources connected yet.</p>
              {canEdit && (
                <button type="button" className="organic-btn organic-btn-dark" onClick={onAddSource}>
                  Add New Source
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
