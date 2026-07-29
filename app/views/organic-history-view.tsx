"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { formatDuration } from "../../lib/domain";
import type { Episode } from "../../lib/types";

function episodeStatusLabel(status: Episode["status"]): string {
  return status.replaceAll("_", " ").toUpperCase();
}

function statusTone(status: Episode["status"]): string {
  if (status === "published" || status === "approved") return "published";
  if (status === "failed") return "failed";
  return "processing";
}

export function OrganicHistoryView({
  episodes,
  onReview,
  onPreview,
  onNewBriefing,
  canCreate,
}: {
  episodes: Episode[];
  canCreate: boolean;
  onReview: (episode: Episode) => void;
  onPreview: (episode: Episode) => void;
  onNewBriefing: () => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [category, setCategory] = useState("all");
  const [page, setPage] = useState(0);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const filtered = useMemo(
    () =>
      [...episodes]
        .sort(
          (left, right) =>
            new Date(right.createdAt).getTime() -
            new Date(left.createdAt).getTime(),
        )
        .filter((episode) => {
          const matchesQuery =
            !deferredQuery ||
            `${episode.title} ${episode.dek} ${episode.showNotes}`
              .toLowerCase()
              .includes(deferredQuery);
          const matchesStatus = status === "all" || episode.status === status;
          const matchesCategory =
            category === "all" || episode.type === category;
          return matchesQuery && matchesStatus && matchesCategory;
        }),
    [category, deferredQuery, episodes, status],
  );
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );

  return (
    <div className="organic-history">
      <div className="organic-published-head">
        <div>
          <h2 className="organic-page-title inline">
            Run History <span className="organic-archive-badge">ALL RUNS</span>
          </h2>
          <p className="organic-history-intro">
            Reopen drafts, review completed episodes, and inspect every
            generation saved in this workspace.
          </p>
        </div>
        {canCreate && (
          <button
            type="button"
            className="organic-btn organic-btn-lime compact"
            onClick={onNewBriefing}
          >
            New Briefing
          </button>
        )}
      </div>

      <div className="organic-filters">
        <label>
          <span>Search Runs</span>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            placeholder="Search title or episode details..."
          />
        </label>
        <label>
          <span>Status</span>
          <select
            value={status}
            aria-label="Run status"
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">All statuses</option>
            <option value="needs_approval">Needs review</option>
            <option value="published">Published</option>
            <option value="approved">Approved</option>
            <option value="generating">Processing</option>
            <option value="failed">Failed</option>
            <option value="draft">Draft</option>
          </select>
        </label>
        <label>
          <span>Category</span>
          <select
            value={category}
            aria-label="Run category"
            onChange={(event) => {
              setCategory(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">All streams</option>
            <option value="daily_digest">Daily digest</option>
            <option value="paper_deep_dive">Paper deep dive</option>
            <option value="blog_deep_dive">Blog deep dive</option>
          </select>
        </label>
      </div>

      <div className="organic-table organic-history-table">
        <div className="organic-table-head">
          <span>RUN DETAILS</span>
          <span>DURATION</span>
          <span>STATUS</span>
          <span>ACTIONS</span>
        </div>
        {visible.map((episode) => (
          <article key={episode.id} className="organic-episode-row">
            <div className="organic-episode-main">
              <span className="organic-episode-thumb">KZ</span>
              <div>
                <p className="organic-eyebrow">
                  {new Date(episode.createdAt)
                    .toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                      timeZone: "UTC",
                    })
                    .toUpperCase()}{" "}
                  • {episode.type.replaceAll("_", " ").toUpperCase()}
                </p>
                <h4>{episode.title}</h4>
                <small>Generation {episode.generation}</small>
              </div>
            </div>
            <div>
              <strong>{formatDuration(episode.durationSeconds)}</strong>
              <small>
                {episode.script.split(/\s+/).filter(Boolean).length.toLocaleString()}{" "}
                words
              </small>
            </div>
            <div>
              <span
                className={`organic-status organic-status-${statusTone(episode.status)}`}
              >
                {episodeStatusLabel(episode.status)}
              </span>
              <small>{episode.citations.length} cited sources</small>
            </div>
            <div className="organic-history-actions">
              {episode.audioUrl && (
                <button
                  type="button"
                  className="organic-btn organic-btn-outline compact"
                  onClick={() => onPreview(episode)}
                >
                  Preview
                </button>
              )}
              <button
                type="button"
                className="organic-btn organic-btn-dark compact"
                onClick={() => onReview(episode)}
              >
                Review
              </button>
            </div>
          </article>
        ))}
        {!visible.length && (
          <div className="organic-empty-panel">
            No runs match these filters.
          </div>
        )}
      </div>

      <div className="organic-pagination">
        <span>
          Showing {filtered.length ? safePage * pageSize + 1 : 0}-
          {Math.min((safePage + 1) * pageSize, filtered.length)} of{" "}
          {filtered.length} runs
        </span>
        <div>
          <button
            type="button"
            className="organic-btn organic-btn-outline"
            disabled={safePage === 0}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            Previous
          </button>
          <button
            type="button"
            className="organic-btn organic-btn-dark"
            disabled={safePage >= pageCount - 1}
            onClick={() =>
              setPage((value) => Math.min(pageCount - 1, value + 1))
            }
          >
            Next Page
          </button>
        </div>
      </div>
    </div>
  );
}
