import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import { CHATTERBOX_AUDIO_CONTENT_TYPE, synthesizeChatterboxSpeech } from "../../../../../lib/chatterbox";
import { findEpisode, getActiveVoiceProfile, getDashboardState, replaceEpisodeAudio } from "../../../../../lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ownerId = await currentOwner();
    const { id } = await context.params;
    const [episode, voiceProfile] = await Promise.all([findEpisode(ownerId, id), getActiveVoiceProfile(ownerId)]);
    if (!episode) return Response.json({ error: "Episode not found." }, { status: 404 });
    if (!voiceProfile) return Response.json({ error: "Choose a local Chatterbox narrator before regenerating audio." }, { status: 400 });
    if (process.env.VERCEL) return Response.json({ error: "Regenerate local Chatterbox audio from the local SignalCast server, not Vercel." }, { status: 400 });
    const audio = await synthesizeChatterboxSpeech(
      episode.script,
      voiceProfile.sampleKey,
      episode.durationSeconds,
    );
    await replaceEpisodeAudio(ownerId, episode, audio, CHATTERBOX_AUDIO_CONTENT_TYPE);
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json(
      { error: error instanceof Error ? error.message : "Unable to regenerate local audio." },
      { status: 500 },
    );
  }
}
