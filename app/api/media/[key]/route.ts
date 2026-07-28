import { getMedia } from "../../../../lib/store";
import { parseMediaByteRange } from "../../../../lib/media-range";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ key: string }> },
) {
  const { key } = await context.params;
  const object = await getMedia(decodeURIComponent(key));
  if (!object) return new Response("Not found", { status: 404 });

  const totalBytes = object.body.size;
  const rangeHeader = request.headers.get("range");
  const sharedHeaders = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": object.contentType,
  };

  if (rangeHeader) {
    const range = parseMediaByteRange(rangeHeader, totalBytes);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: {
          ...sharedHeaders,
          "Content-Range": `bytes */${totalBytes}`,
        },
      });
    }

    return new Response(
      object.body.slice(range.start, range.end + 1, object.contentType),
      {
        status: 206,
        headers: {
          ...sharedHeaders,
          "Content-Length": String(range.length),
          "Content-Range": `bytes ${range.start}-${range.end}/${totalBytes}`,
        },
      },
    );
  }

  return new Response(object.body, {
    headers: {
      ...sharedHeaders,
      "Content-Length": String(totalBytes),
    },
  });
}
