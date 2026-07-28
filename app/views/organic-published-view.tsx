"use client";

import { useMemo, useState } from "react";
import type { Episode } from "../../lib/types";
import { formatDuration } from "../../lib/domain";

export function OrganicPublishedView({ episodes, onNewBriefing, onReview, onPreview }: { episodes: Episode[]; onNewBriefing: () => void; onReview: (episode: Episode) => void; onPreview: (episode: Episode) => void }) {
  const [query, setQuery] = useState("");
  const [timeframe, setTimeframe] = useState("all");
  const [category, setCategory] = useState("all");
  const [page, setPage] = useState(0);
  const [now] = useState(() => Date.now());
  const published = useMemo(
    () =>
      episodes.filter(
        (e) =>
          e.status === "published" ||
          e.status === "approved",
      ),
    [episodes],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return published.filter((episode) => {
      const matchesQuery = !q || `${episode.title} ${episode.dek} ${episode.showNotes}`.toLowerCase().includes(q);
      const matchesCategory = category === "all" || episode.type === category;
      const age = now - new Date(episode.publishedAt ?? episode.createdAt).getTime();
      const matchesTime = timeframe === "all" || (timeframe === "30" ? age <= 30 * 86_400_000 : age <= 365 * 86_400_000);
      return matchesQuery && matchesCategory && matchesTime;
    });
  }, [published, query, timeframe, category, now]);
  const pageSize = 6;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className="organic-published">
      <div className="organic-published-head">
        <div>
          <h2 className="organic-page-title inline">
            Published Episodes <span className="organic-archive-badge">ARCHIVE</span>
          </h2>
        </div>
        <button type="button" className="organic-btn organic-btn-lime compact" onClick={onNewBriefing}>
          New Briefing
        </button>
      </div>

      <div className="organic-filters">
        <label>
          <span>Search Archive</span>
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            placeholder="Filter by title, guest, or keyword..."
          />
        </label>
        <label>
          <span>Timeframe</span>
            <select value={timeframe} aria-label="Timeframe" onChange={(e) => { setTimeframe(e.target.value); setPage(0); }}>
              <option value="all">All Time</option>
              <option value="30">Last 30 days</option>
              <option value="365">Last year</option>
          </select>
        </label>
        <label>
          <span>Category</span>
            <select value={category} aria-label="Category" onChange={(e) => { setCategory(e.target.value); setPage(0); }}>
              <option value="all">All Streams</option>
              <option value="daily_digest">Daily digest</option>
              <option value="paper_deep_dive">Paper deep dive</option>
              <option value="blog_deep_dive">Blog deep dive</option>
          </select>
        </label>
      </div>

      <div className="organic-table">
        <div className="organic-table-head">
          <span>EPISODE DETAILS</span>
          <span>DURATION</span>
          <span>ENGAGEMENT</span>
          <span>ACTION</span>
        </div>
        {visible.map((episode) => (
          <article key={episode.id} className="organic-episode-row">
            <div className="organic-episode-main">
              <span className="organic-episode-thumb">KZ</span>
              <div>
                <p className="organic-eyebrow">
                  {new Date(episode.publishedAt ?? episode.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).toUpperCase()} • {episode.type.replaceAll("_", " ").toUpperCase()}
                </p>
                <h4>{episode.title}</h4>
                <span className="organic-pill organic-pill-lime small">{episode.status.toUpperCase()}</span>
              </div>
            </div>
            <div>
              <strong>{formatDuration(episode.durationSeconds)}</strong>
              <small>{episode.audioUrl ? "Audio ready" : "Transcript only"}</small>
            </div>
            <div>
              <strong>{episode.citations.length} SOURCES</strong>
              <small>{episode.script.split(/\s+/).filter(Boolean).length.toLocaleString()} WORDS</small>
            </div>
            <div className="organic-history-actions">
              {episode.audioUrl && (
                <button
                  type="button"
                  className="organic-btn organic-btn-outline compact"
                  onClick={() => onPreview(episode)}
                >
                  Play
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
      </div>

      <div className="organic-pagination">
        <span>
          Showing {filtered.length ? page * pageSize + 1 : 0}-{Math.min((page + 1) * pageSize, filtered.length)} of {filtered.length} episodes
        </span>
        <div>
            <button type="button" className="organic-btn organic-btn-outline" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
            Previous
          </button>
            <button type="button" className="organic-btn organic-btn-dark" disabled={page >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>
            Next Page
          </button>
        </div>
      </div>
    </div>
  );
}
