"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type {
  PlatformCreator,
  PlatformEpisode,
} from "../../lib/platform-directory";
import { PlaybackAudio } from "../components/organic/playback-audio";

function formatEpisodeDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const remaining = Math.max(0, seconds) % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function CreatorAvatar({
  creator,
}: {
  creator: Pick<PlatformCreator, "displayName" | "avatarUrl">;
}) {
  return (
    <img
      className="platform-creator-avatar"
      src={creator.avatarUrl || "/user-placeholder.svg"}
      alt={`${creator.displayName}'s profile`}
    />
  );
}

export function ExploreDirectory({
  episodes,
  creators,
  page,
  pageSize,
  totalEpisodes,
  totalPages,
}: {
  episodes: PlatformEpisode[];
  creators: PlatformCreator[];
  page: number;
  pageSize: number;
  totalEpisodes: number;
  totalPages: number;
}) {
  const [query, setQuery] = useState("");
  const filteredEpisodes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return episodes;
    return episodes.filter((episode) =>
      [
        episode.title,
        episode.dek,
        episode.creator.displayName,
        episode.creator.email,
        episode.type,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [episodes, query]);

  return (
    <div className="platform-directory">
      <section className="platform-directory-hero">
        <div>
          <p className="organic-eyebrow">KERNELZERO COMMUNITY</p>
          <h1>Explore published podcasts</h1>
          <p>
            Listen to public episodes from creators across the platform.
          </p>
        </div>
        <dl className="platform-directory-stats">
          <div>
            <dt>Published</dt>
            <dd>{totalEpisodes}</dd>
          </div>
          <div>
            <dt>Creators shown</dt>
            <dd>{creators.length}</dd>
          </div>
        </dl>
      </section>

      <label className="platform-directory-search">
        <span>Search podcasts or creators on this page</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try a title, topic, creator, or email"
        />
      </label>

      {filteredEpisodes.length === 0 ? (
        <section className="organic-empty-panel">
          <h2>
            {episodes.length
              ? "No matching podcasts on this page"
              : "No published podcasts yet"}
          </h2>
          <p>
            {episodes.length
              ? "Try a broader title, topic, or creator search."
              : "Audio-ready episodes will appear here after they are published."}
          </p>
        </section>
      ) : (
        <div className="platform-episode-grid">
          {filteredEpisodes.map((episode) => (
            <article key={episode.id} className="platform-episode-card">
              <div className="platform-episode-meta">
                <span>{episode.type.replaceAll("_", " ")}</span>
                <time dateTime={episode.publishedAt}>
                  {formatDate(episode.publishedAt)}
                </time>
              </div>
              <h2>{episode.title}</h2>
              {episode.dek && <p className="platform-episode-dek">{episode.dek}</p>}

              <Link
                className="platform-creator-link"
                href={`/creators/${encodeURIComponent(episode.creatorId)}`}
                prefetch={false}
              >
                <CreatorAvatar creator={episode.creator} />
                <span>
                  <strong>{episode.creator.displayName}</strong>
                  <small>{episode.creator.email}</small>
                </span>
              </Link>

              <div className="platform-episode-facts">
                <span>{formatEpisodeDuration(episode.durationSeconds)}</span>
                <span>
                  {episode.citationCount} source
                  {episode.citationCount === 1 ? "" : "s"}
                </span>
              </div>

              <PlaybackAudio src={episode.audioUrl} title={episode.title} />
            </article>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="platform-pagination" aria-label="Podcast pages">
          {page > 1 ? (
            <Link
              href={`/explore?page=${page - 1}&pageSize=${pageSize}`}
              prefetch={false}
            >
              ← Previous
            </Link>
          ) : (
            <span aria-disabled="true">← Previous</span>
          )}
          <p>
            Page {page} of {totalPages}
          </p>
          {page < totalPages ? (
            <Link
              href={`/explore?page=${page + 1}&pageSize=${pageSize}`}
              prefetch={false}
            >
              Next →
            </Link>
          ) : (
            <span aria-disabled="true">Next →</span>
          )}
        </nav>
      )}
    </div>
  );
}
