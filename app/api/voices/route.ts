import { authErrorResponse, currentOwner } from "../../../lib/auth";
import { assertChatterboxAvailable } from "../../../lib/chatterbox";
import { deleteVoiceSample, saveVoiceSample, validateVoiceSampleDuration } from "../../../lib/local-voice";
import {
  disconnectVoiceProfile,
  getDashboardState,
  saveVoiceProfile,
} from "../../../lib/store";
import { voiceAudioFile } from "../../../lib/voice-upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    if (name.length < 2 || name.length > 80) {
      return Response.json({ error: "Voice name must be 2–80 characters." }, { status: 400 });
    }
    if (form.get("consentAcknowledged") !== "true") {
      return Response.json(
        { error: "Confirm that the speaker owns this voice and has given permission." },
        { status: 400 },
      );
    }

    const ownerId = await currentOwner("owner");
    const audioSample = voiceAudioFile(form.get("audioSample"), "Voice sample");
    await assertChatterboxAvailable();
    const sampleKey = await saveVoiceSample(audioSample);
    try {
      await validateVoiceSampleDuration(sampleKey);
      await saveVoiceProfile(
        ownerId,
        {
          id: `voice-profile-${crypto.randomUUID()}`,
          name,
          provider: "chatterbox",
          active: true,
          createdAt: new Date().toISOString(),
        },
        sampleKey,
      );
    } catch (error) {
      await deleteVoiceSample(sampleKey);
      throw error;
    }
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Unable to save the local voice." },
        { status: 500 },
      )
    );
  }
}

export async function DELETE() {
  try {
    const ownerId = await currentOwner("owner");
    await deleteVoiceSample(await disconnectVoiceProfile(ownerId));
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Unable to remove the local voice." },
        { status: 500 },
      )
    );
  }
}
