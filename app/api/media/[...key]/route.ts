import { currentUser } from "../../../../lib/auth";
import { mediaKeyFromRoute } from "../../../../lib/media-path";
import {
  getMediaEpisodeAccess,
  getSignedMediaUrl,
} from "../../../../lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string[] }> },
) {
  const params = await context.params;
  const key = mediaKeyFromRoute(params.key);
  if (!key) return new Response("Not found", { status: 404 });

  const access = await getMediaEpisodeAccess(key);
  if (!access) return new Response("Not found", { status: 404 });

  const isPublic = access.status === "published";
  if (!isPublic) {
    const user = await currentUser();
    if (!user || user.workspaceOwnerId !== access.ownerId) {
      return new Response("Not found", { status: 404 });
    }
  }

  const signedUrl = await getSignedMediaUrl(key);
  if (!signedUrl) return new Response("Not found", { status: 404 });

  // Let Storage stream the object and honor Range upstream. This avoids
  // downloading an entire podcast into the application for a tiny byte range.
  return new Response(null, {
    status: 307,
    headers: {
      Location: signedUrl,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
