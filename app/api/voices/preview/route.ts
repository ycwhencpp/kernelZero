import { authErrorResponse, currentOwner } from "../../../../lib/auth";
import {
  CHATTERBOX_AUDIO_CONTENT_TYPE,
  assertChatterboxAvailable,
  synthesizeChatterboxSpeech,
} from "../../../../lib/chatterbox";
import {
  deleteVoiceSample,
  saveVoiceSample,
  validateVoiceSampleDuration,
} from "../../../../lib/local-voice";
import { getActiveVoiceProfile } from "../../../../lib/store";
import { voiceAudioFile } from "../../../../lib/voice-upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PREVIEW_SCRIPT =
  "This is your KernelZero local voice preview. It will narrate evidence-grounded technology briefings using this voice.";

export async function POST(request: Request) {
  let temporarySampleKey: string | null = null;
  try {
    const ownerId = await currentOwner();
    const form = await request.formData();
    await assertChatterboxAvailable();

    const pendingSample = form.get("audioSample");
    const activeProfile = await getActiveVoiceProfile(ownerId);
    const sampleKey = pendingSample
      ? await (async () => {
          if (form.get("consentAcknowledged") !== "true") {
            throw new Error("Confirm that the speaker owns this voice and has given permission.");
          }
          temporarySampleKey = await saveVoiceSample(voiceAudioFile(pendingSample, "Voice sample"));
          await validateVoiceSampleDuration(temporarySampleKey);
          return temporarySampleKey;
        })()
      : activeProfile?.sampleKey;

    if (!sampleKey) {
      throw new Error("Upload a reference sample or save a local Chatterbox voice before previewing.");
    }

    const audio = await synthesizeChatterboxSpeech(PREVIEW_SCRIPT, sampleKey);
    return new Response(audio, {
      headers: {
        "Content-Type": CHATTERBOX_AUDIO_CONTENT_TYPE,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Unable to generate the voice preview." },
        { status: 500 },
      )
    );
  } finally {
    await deleteVoiceSample(temporarySampleKey);
  }
}
