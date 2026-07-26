export const MAX_VOICE_AUDIO_BYTES = 10 * 1024 * 1024;

const supportedVoiceAudioTypes = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
  "audio/webm",
  "audio/mp4",
]);

export function voiceAudioFile(value: FormDataEntryValue | null, label: string): File {
  if (!value || typeof value === "string" || value.size === 0) {
    throw new Error(`${label} is required.`);
  }
  if (value.size > MAX_VOICE_AUDIO_BYTES) {
    throw new Error(`${label} must be 10 MB or smaller.`);
  }
  if (!supportedVoiceAudioTypes.has(value.type)) {
    throw new Error(`${label} must be MP3, WAV, OGG, AAC, FLAC, WebM, or MP4 audio.`);
  }
  return value;
}
