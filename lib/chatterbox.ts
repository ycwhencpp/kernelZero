import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chunkForSpeech } from "./speech-chunk";
import { resolveVoiceSample } from "./local-voice";
import { prepareForChatterbox } from "./narration-text";

const execFileAsync = promisify(execFile);

type ChatterboxRequest = {
  chunks: string[];
  samplePath: string;
  device: string;
};

function pythonCommand(): string {
  return process.env.CHATTERBOX_PYTHON || ".venv-chatterbox/bin/python";
}

function chatterboxDevice(): string {
  return process.env.CHATTERBOX_DEVICE || "mps";
}

function chatterboxCacheDirectory(): string | undefined {
  return process.env.CHATTERBOX_CACHE_DIR ? resolve(process.env.CHATTERBOX_CACHE_DIR) : undefined;
}

export async function assertChatterboxAvailable(): Promise<void> {
  try {
    await access(pythonCommand());
  } catch {
    throw new Error(
      `Chatterbox is not installed. Create the local environment with: python3.11 -m venv .venv-chatterbox && .venv-chatterbox/bin/python -m pip install chatterbox-tts`,
    );
  }
}

/** Creates MP3 narration with Chatterbox Turbo and a locally stored reference sample. */
export async function synthesizeChatterboxSpeech(
  script: string,
  sampleKey: string,
  targetDurationSeconds?: number,
): Promise<ArrayBuffer> {
  await assertChatterboxAvailable();
  const workDir = await mkdtemp(join(tmpdir(), "signalcast-chatterbox-"));
  const requestPath = join(workDir, "request.json");
  const wavPath = join(workDir, "speech.wav");
  const mp3Path = join(workDir, "speech.mp3");
  const workerPath = resolve("scripts/chatterbox_tts.py");
  const ffmpegCommand = process.env.LOCAL_FFMPEG_COMMAND || "ffmpeg";
  const ffprobeCommand = process.env.LOCAL_FFPROBE_COMMAND || "ffprobe";
  const request: ChatterboxRequest = {
    // Chatterbox Turbo is tuned for short voice-agent turns. Sentence-sized
    // chunks prevent long-form narration from drifting into silence or noise.
    chunks: chunkForSpeech(prepareForChatterbox(script), 260),
    samplePath: resolveVoiceSample(sampleKey),
    device: chatterboxDevice(),
  };
  if (request.chunks.length === 0) {
    throw new Error("The narration script contains no speakable text.");
  }

  try {
    await writeFile(requestPath, JSON.stringify(request), "utf8");
    const cacheDirectory = chatterboxCacheDirectory();
    await execFileAsync(pythonCommand(), [workerPath, requestPath, wavPath], {
      env: { ...process.env, ...(cacheDirectory ? { HF_HOME: cacheDirectory } : {}) },
      maxBuffer: 1024 * 1024,
      timeout: Number(process.env.CHATTERBOX_TIMEOUT_MS || 30 * 60_000),
    });
    let tempoFilter: string[] = [];
    if (targetDurationSeconds && targetDurationSeconds > 0) {
      const { stdout } = await execFileAsync(
        ffprobeCommand,
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", wavPath],
        { maxBuffer: 1024 * 1024 },
      );
      const generatedDurationSeconds = Number.parseFloat(stdout.trim());
      const tempo = generatedDurationSeconds / targetDurationSeconds;
      if (Number.isFinite(tempo) && tempo >= 0.5 && tempo <= 2 && Math.abs(tempo - 1) > 0.02) {
        tempoFilter = ["-filter:a", `atempo=${tempo.toFixed(6)}`];
      }
    }
    await execFileAsync(
      ffmpegCommand,
      ["-y", "-loglevel", "error", "-i", wavPath, ...tempoFilter, "-codec:a", "libmp3lame", "-b:a", "128k", mp3Path],
      { maxBuffer: 1024 * 1024 },
    );
    const audio = await readFile(mp3Path);
    return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Chatterbox voice generation failed: ${detail}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export const CHATTERBOX_AUDIO_CONTENT_TYPE = "audio/mpeg";
