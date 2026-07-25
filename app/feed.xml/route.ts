import { escapeXml, formatDuration } from "../../lib/domain";
import { getPublicEpisodes } from "../../lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const configuredBase = process.env.PODCAST_BASE_URL?.replace(/\/$/, "");
  const requestUrl = new URL(request.url);
  const baseUrl = configuredBase || requestUrl.origin;
  const title = process.env.PODCAST_TITLE || "SignalCast Daily";
  const description =
    process.env.PODCAST_DESCRIPTION ||
    "Research papers and technology shifts, distilled into clear daily audio.";
  const email = process.env.PODCAST_EMAIL || "creator@example.com";
  const episodes = await getPublicEpisodes();
  const items = episodes
    .map(
      (episode) => `<item>
  <title>${escapeXml(episode.title)}</title>
  <description>${escapeXml(`${episode.dek}\n\n${episode.showNotes}`)}</description>
  <guid isPermaLink="false">${escapeXml(episode.immutableGuid)}</guid>
  <link>${escapeXml(`${baseUrl}/?episode=${episode.id}`)}</link>
  <pubDate>${new Date(episode.publishedAt || episode.createdAt).toUTCString()}</pubDate>
  <enclosure url="${escapeXml(episode.audioUrl || "")}" length="${episode.audioBytes ?? 0}" type="audio/mpeg" />
  <itunes:duration>${formatDuration(episode.durationSeconds)}</itunes:duration>
  <itunes:episodeType>full</itunes:episodeType>
  <podcast:transcript url="${escapeXml(`${baseUrl}/api/transcripts/${episode.id}`)}" type="text/plain" />
</item>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel>
  <title>${escapeXml(title)}</title>
  <link>${escapeXml(baseUrl)}</link>
  <description>${escapeXml(description)}</description>
  <language>en</language>
  <copyright>© ${new Date().getUTCFullYear()} SignalCast</copyright>
  <managingEditor>${escapeXml(email)} (SignalCast)</managingEditor>
  <itunes:author>SignalCast</itunes:author>
  <itunes:owner><itunes:name>SignalCast</itunes:name><itunes:email>${escapeXml(email)}</itunes:email></itunes:owner>
  <itunes:explicit>false</itunes:explicit>
  <itunes:category text="Technology" />
  <itunes:image href="${escapeXml(`${baseUrl}/podcast-cover.png`)}" />
  <atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${escapeXml(`${baseUrl}/feed.xml`)}" rel="self" type="application/rss+xml" />
  ${items}
</channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
