import { authErrorResponse, currentOwner } from "../../../../lib/auth";
import {
  findEpisode,
  getDashboardState,
  updateEpisode,
} from "../../../../lib/store";
import { chaptersForManuallyEditedScript } from "../../../../lib/chapter-mapping";
import { episodeTitleGenerationWarning } from "../../../../lib/title-validation";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner("editor");
    const { id } = await context.params;
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return Response.json({ error: "Episode changes are required." }, { status: 400 });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return Response.json({ error: "Episode changes are required." }, { status: 400 });
    }
    const body = value as {
      title?: unknown;
      dek?: unknown;
      script?: unknown;
      showNotes?: unknown;
    };
    if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim())) {
      return Response.json({ error: "Title cannot be empty." }, { status: 400 });
    }
    if (body.dek !== undefined && typeof body.dek !== "string") {
      return Response.json({ error: "Episode summary must be text." }, { status: 400 });
    }
    if (body.script !== undefined && (typeof body.script !== "string" || !body.script.trim())) {
      return Response.json({ error: "Script cannot be empty." }, { status: 400 });
    }
    if (body.showNotes !== undefined && typeof body.showNotes !== "string") {
      return Response.json({ error: "Show notes must be text." }, { status: 400 });
    }
    if (
      body.title === undefined &&
      body.dek === undefined &&
      body.script === undefined &&
      body.showNotes === undefined
    ) {
      return Response.json({ error: "Episode changes are required." }, { status: 400 });
    }
    const episode = await findEpisode(ownerId, id);
    if (!episode) {
      return Response.json({ error: "Episode not found." }, { status: 404 });
    }
    const title = typeof body.title === "string" ? body.title.trim() : episode.title;
    const script = typeof body.script === "string" ? body.script : episode.script;
    const titleChanged = title !== episode.title;
    const scriptChanged = script !== episode.script;
    await updateEpisode(ownerId, id, {
      title: typeof body.title === "string" ? title : undefined,
      dek: typeof body.dek === "string" ? body.dek.trim() : undefined,
      script: typeof body.script === "string" ? script : undefined,
      transcript: typeof body.script === "string" ? script : undefined,
      showNotes: typeof body.showNotes === "string" ? body.showNotes : undefined,
      // Stable semantic offsets no longer describe a manually edited script.
      // Dropping them makes the review UI use its legacy paragraph mapping.
      chapters: scriptChanged
        ? chaptersForManuallyEditedScript(episode.chapters)
        : undefined,
      // A metadata-only save must not silently clear a durable warning. Only a
      // real title or transcript change authorizes a fresh alignment verdict,
      // and a title-only save keeps a length warning the transcript still earns.
      generationWarning: titleChanged || scriptChanged
        ? episodeTitleGenerationWarning(title, script) ??
          (!scriptChanged && episode.generationWarning === "length_below_target"
            ? "length_below_target"
            : null)
        : undefined,
      // Once an editor changes either input, a later audio retry must never
      // replace that authored title with the deferred Gemini pass.
      titleProvenance: titleChanged || scriptChanged
        ? "manual"
        : undefined,
    });
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: error instanceof Error ? error.message : "Unable to update episode." }, { status: 500 });
  }
}
