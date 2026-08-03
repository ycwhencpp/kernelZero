import Link from "next/link";
import type {
  PlatformCreator,
  PlatformEpisode,
} from "../../../lib/platform-directory";

function formatJoinedDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatEpisodeDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const remaining = Math.max(0, seconds) % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

function formatTotalDuration(seconds: number): string {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes} min`;
}

export function CreatorProfile({
  creator,
  episodes,
}: {
  creator: PlatformCreator;
  episodes: PlatformEpisode[];
}) {
  return (
    <div className="platform-creator-page">
      <Link className="platform-back-link" href="/explore" prefetch={false}>
        ← Back to Explore
      </Link>

      <section className="platform-creator-hero">
        <img
          src={creator.avatarUrl || "/user-placeholder.svg"}
          alt={`${creator.displayName}'s profile`}
        />
        <div className="platform-creator-identity">
          <p className="organic-eyebrow">CREATOR PROFILE</p>
          <h1>{creator.displayName}</h1>
          <a href={`mailto:${creator.email}`}>{creator.email}</a>
          <p>Joined {formatJoinedDate(creator.joinedAt)}</p>
        </div>
        <dl>
          <div>
            <dt>Published podcasts</dt>
            <dd>{creator.episodeCount}</dd>
          </div>
          <div>
            <dt>Total podcast time</dt>
            <dd>{formatTotalDuration(creator.totalDurationSeconds)}</dd>
          </div>
        </dl>
      </section>

      <section className="platform-creator-episodes">
        <div className="platform-section-heading">
          <div>
            <p className="organic-eyebrow">PUBLIC LIBRARY</p>
            <h2>Published podcasts</h2>
          </div>
          <span>{episodes.length} total</span>
        </div>

        {episodes.length === 0 ? (
          <div className="organic-empty-panel">
            This creator has no audio-ready published podcasts.
          </div>
        ) : (
          <div className="platform-creator-episode-list">
            {episodes.map((episode) => (
              <article key={episode.id}>
                <div>
                  <p className="organic-eyebrow">
                    {episode.type.replaceAll("_", " ")} ·{" "}
                    {formatEpisodeDuration(episode.durationSeconds)}
                  </p>
                  <h3>{episode.title}</h3>
                  {episode.dek && <p>{episode.dek}</p>}
                </div>
                <audio controls preload="none" src={episode.audioUrl}>
                  Your browser does not support audio playback.
                </audio>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
