import { getPublicEpisode } from "../../../../lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const episode = await getPublicEpisode(id);
  if (!episode) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(episode.transcript, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
