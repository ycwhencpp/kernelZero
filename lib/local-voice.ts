import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const extensionByType: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/webm": ".webm",
  "audio/mp4": ".m4a",
};

function voiceStorageDirectory(): string {
  return resolve(process.env.LOCAL_VOICE_STORAGE_DIR || ".signalcast/voices");
}

function validateVoiceKey(key: string): string {
  if (!/^voice-[a-f0-9-]+\.(?:mp3|wav|ogg|aac|flac|webm|m4a)$/i.test(key)) {
    throw new Error("Invalid local voice reference.");
  }
  return key;
}

export async function saveVoiceSample(file: File): Promise<string> {
  const extension = extensionByType[file.type] || extname(file.name).toLowerCase();
  if (!extension || !/^\.(?:mp3|wav|ogg|aac|flac|webm|m4a)$/i.test(extension)) {
    throw new Error("The voice sample format is not supported.");
  }
  const key = `voice-${crypto.randomUUID()}${extension}`;
  const directory = voiceStorageDirectory();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, key), Buffer.from(await file.arrayBuffer()));
  return key;
}

export function resolveVoiceSample(key: string): string {
  return join(voiceStorageDirectory(), validateVoiceKey(key));
}

export async function validateVoiceSampleDuration(key: string): Promise<void> {
  const ffprobeCommand = process.env.LOCAL_FFPROBE_COMMAND || "ffprobe";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      ffprobeCommand,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", resolveVoiceSample(key)],
      { maxBuffer: 1024 * 1024 },
    ));
  } catch {
    throw new Error("Unable to read the reference recording. Upload a standard audio file and make sure FFmpeg is installed.");
  }
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 5 || duration > 30) {
    throw new Error("The reference recording must be between 6 and 30 seconds.");
  }
}

export async function deleteVoiceSample(key: string | null | undefined): Promise<void> {
  if (!key) return;
  await unlink(resolveVoiceSample(key)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
