import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveVoiceSample } from "./local-voice";
import {
  chatterboxMaxTempoAdjustment,
  CHATTERBOX_TARGET_WORDS_PER_MINUTE,
  CHATTERBOX_TTS_DELIVERY_PROMPT,
  chatterboxTargetDurationSeconds,
  chatterboxWordsPerMinuteRange,
} from "./chatterbox-delivery";
import {
  naturalNarrationTempo,
  prepareChatterboxSegments,
  type ChatterboxNarrationSegment,
} from "./narration-text";

const execFileAsync = promisify(execFile);

type ChatterboxRequest = {
  segments: ChatterboxNarrationSegment[];
  samplePath: string;
  checkpointDir: string;
  retryEpoch: number;
  device: string;
  deliveryPrompt: string;
  targetWordsPerMinute: number;
  minWordsPerMinute: number;
  maxWordsPerMinute: number;
  maxTempoAdjustment: number;
  generation: {
    repetitionPenalty: number;
    temperature: number;
    topP: number;
  };
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

function logChatterboxDiagnostics(output: unknown): void {
  if (typeof output !== "string") return;
  for (const outputLine of output.split(/[\r\n]+/)) {
    const marker = outputLine.indexOf("[chatterbox] ");
    if (marker >= 0) console.info(outputLine.slice(marker));
  }
}

function chatterboxWorkerFailureDetail(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    const workerError = stderr
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => /^(?:ValueError|RuntimeError):\s+/.test(line));
    if (workerError) {
      return workerError.replace(/^(?:ValueError|RuntimeError):\s+/, "");
    }
    return "The local Chatterbox worker exited before completing narration.";
  }
  if (error instanceof Error && !/[\r\n]/.test(error.message)) {
    return error.message;
  }
  return "The local Chatterbox worker failed.";
}

function canResumeChatterboxWorker(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("stderr" in error)) {
    return false;
  }
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  return /Chatterbox could not produce clear audio for chunk \d+/i.test(stderr);
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
  const wordsPerMinuteRange = chatterboxWordsPerMinuteRange();
  const maxTempoAdjustment = chatterboxMaxTempoAdjustment();
  const request: ChatterboxRequest = {
    // Chatterbox Turbo is tuned for short voice-agent turns. Sentence-sized
    // segments prevent long-form narration from drifting into silence or
    // noise, while their explicit pauses preserve the host's natural beats.
    segments: prepareChatterboxSegments(script, 260),
    samplePath: resolveVoiceSample(sampleKey),
    checkpointDir: join(workDir, "segments"),
    retryEpoch: 0,
    device: chatterboxDevice(),
    // Turbo has no natural-language instruction channel. Keep the requested
    // contract in the worker request and compile its supported behavior into
    // segmentation, pauses, restrained native cues, sampling, and tempo.
    deliveryPrompt: CHATTERBOX_TTS_DELIVERY_PROMPT,
    targetWordsPerMinute: CHATTERBOX_TARGET_WORDS_PER_MINUTE,
    ...wordsPerMinuteRange,
    maxTempoAdjustment,
    generation: {
      repetitionPenalty: 1.2,
      temperature: 0.8,
      topP: 0.95,
    },
  };
  if (request.segments.length === 0) {
    throw new Error("The narration script contains no speakable text.");
  }

  try {
    const cacheDirectory = chatterboxCacheDirectory();
    let workerCompleted = false;
    for (let retryEpoch = 0; retryEpoch < 2; retryEpoch += 1) {
      request.retryEpoch = retryEpoch;
      await writeFile(requestPath, JSON.stringify(request), "utf8");
      try {
        const { stderr: workerStderr } = await execFileAsync(
          pythonCommand(),
          [workerPath, requestPath, wavPath],
          {
            env: {
              ...process.env,
              ...(cacheDirectory ? { HF_HOME: cacheDirectory } : {}),
            },
            maxBuffer: 1024 * 1024,
            timeout: Number(process.env.CHATTERBOX_TIMEOUT_MS || 30 * 60_000),
          },
        );
        logChatterboxDiagnostics(workerStderr);
        workerCompleted = true;
        break;
      } catch (workerError) {
        if (workerError && typeof workerError === "object" && "stderr" in workerError) {
          logChatterboxDiagnostics(workerError.stderr);
        }
        if (retryEpoch === 0 && canResumeChatterboxWorker(workerError)) {
          console.warn(
            "[chatterbox] retrying the unfinished segment with preserved chunk checkpoints",
          );
          continue;
        }
        throw workerError;
      }
    }
    if (!workerCompleted) {
      throw new Error("The local Chatterbox worker did not complete narration.");
    }
    let tempoFilter: string[] = [];
    const promptedDurationSeconds =
      chatterboxTargetDurationSeconds(script) ?? targetDurationSeconds;
    if (promptedDurationSeconds && promptedDurationSeconds > 0) {
      const { stdout } = await execFileAsync(
        ffprobeCommand,
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", wavPath],
        { maxBuffer: 1024 * 1024 },
      );
      const generatedDurationSeconds = Number.parseFloat(stdout.trim());
      const tempo = naturalNarrationTempo(
        generatedDurationSeconds,
        promptedDurationSeconds,
        maxTempoAdjustment,
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
    if (error && typeof error === "object" && "stderr" in error) {
      logChatterboxDiagnostics(error.stderr);
    }
    const detail = chatterboxWorkerFailureDetail(error);
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
