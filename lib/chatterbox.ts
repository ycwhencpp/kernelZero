import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveVoiceSample } from "./local-voice";
import {
  naturalNarrationTempo,
  prepareChatterboxSegments,
  type ChatterboxNarrationSegment,
} from "./narration-text";

const execFileAsync = promisify(execFile);

type ChatterboxRequest = {
  segments: ChatterboxNarrationSegment[];
  samplePath: string;
  device: string;
};

export type GeneratedChatterboxSpeech = {
  audio: ArrayBuffer;
  durationSeconds: number;
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
export async function synthesizeChatterboxSpeechWithMetadata(
  script: string,
  sampleKey: string,
  targetDurationSeconds?: number,
): Promise<GeneratedChatterboxSpeech> {
  await assertChatterboxAvailable();
  const workDir = await mkdtemp(join(tmpdir(), "kernelzero-chatterbox-"));
  const requestPath = join(workDir, "request.json");
  const wavPath = join(workDir, "speech.wav");
  const mp3Path = join(workDir, "speech.mp3");
  const workerPath = resolve("scripts/chatterbox_tts.py");
  const ffmpegCommand = process.env.LOCAL_FFMPEG_COMMAND || "ffmpeg";
  const ffprobeCommand = process.env.LOCAL_FFPROBE_COMMAND || "ffprobe";
  const request: ChatterboxRequest = {
    // Chatterbox Turbo is tuned for short voice-agent turns. Sentence-sized
    // segments prevent long-form narration from drifting into silence or
    // noise, while their explicit pauses preserve the host's natural beats.
    segments: prepareChatterboxSegments(script, 260),
    samplePath: resolveVoiceSample(sampleKey),
    device: chatterboxDevice(),
  };
  if (request.segments.length === 0) {
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
      const configuredMaxAdjustment = Number.parseFloat(
        process.env.CHATTERBOX_MAX_TEMPO_ADJUSTMENT || "0.08",
      );
      const tempo = naturalNarrationTempo(
        generatedDurationSeconds,
        targetDurationSeconds,
        Number.isFinite(configuredMaxAdjustment)
          ? configuredMaxAdjustment
          : 0.08,
      );
      if (tempo !== null) {
        tempoFilter = ["-filter:a", `atempo=${tempo.toFixed(6)}`];
      }
    }
    await execFileAsync(
      ffmpegCommand,
      ["-y", "-loglevel", "error", "-i", wavPath, ...tempoFilter, "-codec:a", "libmp3lame", "-b:a", "128k", mp3Path],
      { maxBuffer: 1024 * 1024 },
    );
    const { stdout: encodedDuration } = await execFileAsync(
      ffprobeCommand,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", mp3Path],
      { maxBuffer: 1024 * 1024 },
    );
    const durationSeconds = Number.parseFloat(encodedDuration.trim());
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("FFprobe could not determine the generated MP3 duration.");
    }
    const audio = await readFile(mp3Path);
    return {
      audio: audio.buffer.slice(
        audio.byteOffset,
        audio.byteOffset + audio.byteLength,
      ) as ArrayBuffer,
      durationSeconds,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Chatterbox voice generation failed: ${detail}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function synthesizeChatterboxSpeech(
  script: string,
  sampleKey: string,
  targetDurationSeconds?: number,
): Promise<ArrayBuffer> {
  const generated = await synthesizeChatterboxSpeechWithMetadata(
    script,
    sampleKey,
    targetDurationSeconds,
  );
  return generated.audio;
}

export const CHATTERBOX_AUDIO_CONTENT_TYPE = "audio/mpeg";
