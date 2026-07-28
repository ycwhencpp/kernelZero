import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import { CHATTERBOX_AUDIO_CONTENT_TYPE, synthesizeChatterboxSpeechWithMetadata } from "../../../../../lib/chatterbox";
import { hasUsableAudioUrl } from "../../../../../lib/generated-episode";
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
    if (process.env.VERCEL) return Response.json({ error: "Regenerate local Chatterbox audio from the local KernelZero server, not Vercel." }, { status: 400 });
    const generated = await synthesizeChatterboxSpeechWithMetadata(
      episode.script,
      voiceProfile.sampleKey,
      episode.durationSeconds,
    );
    const updatedEpisode = await replaceEpisodeAudio(
      ownerId,
      episode,
      generated.audio,
      CHATTERBOX_AUDIO_CONTENT_TYPE,
      generated.durationSeconds,
    );
    if (!hasUsableAudioUrl(updatedEpisode.audioUrl)) {
      throw new Error("The generated audio could not be stored with the episode.");
    }
    const state = await getDashboardState(ownerId);
    const storedEpisode = state.episodes.find(
      (candidate) => candidate.id === updatedEpisode.id,
    );
    if (
      !storedEpisode ||
      !hasUsableAudioUrl(storedEpisode.audioUrl) ||
      storedEpisode.audioUrl !== updatedEpisode.audioUrl
    ) {
      throw new Error("The stored episode does not reference the generated audio.");
    }
    return Response.json({ episode: storedEpisode, state });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json(
      { error: error instanceof Error ? error.message : "Unable to regenerate local audio." },
      { status: 500 },
    );
  }
}
