#!/usr/bin/env python3
"""Local Chatterbox Turbo worker. Its input and output file paths are supplied by KernelZero."""

import json
import math
import re
import sys

import torch
import torchaudio
from chatterbox.tts_turbo import ChatterboxTurboTTS


LEADING_DELIVERY_TAGS = re.compile(
    r"^(?:\[(?:dramatic|happy|narration|surprised)\]\s*)+",
    re.IGNORECASE,
)


def segment_speech_metrics(
    wav: torch.Tensor,
    text: str,
    sample_rate: int,
) -> tuple[float, int, float]:
    duration = wav.numel() / sample_rate
    spoken_text = LEADING_DELIVERY_TAGS.sub("", text).strip()
    word_count = len(spoken_text.split())
    words_per_minute = word_count * 60.0 / duration if duration > 0 else math.inf
    return duration, word_count, words_per_minute


def validate_speaking_rate(
    words_per_minute: float,
    min_words_per_minute: float,
    max_words_per_minute: float,
) -> None:
    if not min_words_per_minute <= words_per_minute <= max_words_per_minute:
        raise ValueError(
            "Chatterbox speaking rate is outside the configured "
            f"{min_words_per_minute:g}-{max_words_per_minute:g} WPM range."
        )


def emit_segment_diagnostic(
    *,
    index: int,
    attempt: int,
    seed: int,
    duration: float,
    word_count: int,
    words_per_minute: float,
    min_words_per_minute: float,
    max_words_per_minute: float,
    status: str,
    text: str,
    reason: str | None = None,
) -> None:
    diagnostic = {
        "index": index,
        "attempt": attempt,
        "seed": seed,
        "durationSeconds": round(duration, 3) if math.isfinite(duration) else None,
        "wordCount": word_count,
        "wordsPerMinute": round(words_per_minute, 1) if math.isfinite(words_per_minute) else None,
        "minWordsPerMinute": min_words_per_minute,
        "maxWordsPerMinute": max_words_per_minute,
        "status": status,
        "text": text,
    }
    if reason:
        diagnostic["reason"] = reason
    print(
        f"[chatterbox] {json.dumps(diagnostic, separators=(',', ':'))}",
        file=sys.stderr,
        flush=True,
    )


def validate_generated_audio(wav: torch.Tensor, text: str, sample_rate: int) -> None:
    """Reject silent, mostly silent, clipped, or implausibly long model output."""
    samples = wav.flatten().float()
    duration = samples.numel() / sample_rate
    _, spoken_word_count, _ = segment_speech_metrics(wav, text, sample_rate)
    word_count = max(1, spoken_word_count)
    peak = float(samples.abs().max())
    rms = float(torch.sqrt(torch.mean(samples.square()) + 1e-12))

    frame_size = max(1, int(sample_rate * 0.05))
    framed_length = (samples.numel() // frame_size) * frame_size
    if framed_length:
        frames = samples[:framed_length].reshape(-1, frame_size)
        frame_rms = torch.sqrt(torch.mean(frames.square(), dim=1) + 1e-12)
        active_ratio = float((frame_rms > 0.003).float().mean())
    else:
        active_ratio = 0.0

    min_duration = max(0.6, word_count * 0.16)
    max_duration = max(8.0, word_count * 0.9)
    if (
        not math.isfinite(duration)
        or duration < min_duration
        or duration > max_duration
        or peak < 0.01
        or peak > 1.01
        or rms < 0.003
        or active_ratio < 0.35
    ):
        raise ValueError(
            "Chatterbox produced invalid audio "
            f"(duration={duration:.2f}s, peak={peak:.4f}, rms={rms:.4f}, active={active_ratio:.2f})."
        )


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: chatterbox_tts.py REQUEST_JSON OUTPUT_WAV")

    with open(sys.argv[1], "r", encoding="utf-8") as request_file:
        request = json.load(request_file)

    segments = request.get("segments")
    sample_path = request.get("samplePath")
    device = request.get("device", "mps")
    delivery_prompt = request.get("deliveryPrompt")
    target_words_per_minute = request.get("targetWordsPerMinute")
    min_words_per_minute = request.get("minWordsPerMinute", 130)
    max_words_per_minute = request.get("maxWordsPerMinute", 190)
    generation = request.get("generation")
    if not isinstance(segments, list) or not segments:
        raise ValueError("Chatterbox needs at least one narration segment.")
    if not isinstance(delivery_prompt, str) or not delivery_prompt.strip():
        raise ValueError("Chatterbox needs a delivery contract.")
    if (
        isinstance(target_words_per_minute, bool)
        or not isinstance(target_words_per_minute, (int, float))
        or not 120 <= float(target_words_per_minute) <= 220
    ):
        raise ValueError("Chatterbox needs a realistic words-per-minute target.")
    if (
        isinstance(min_words_per_minute, bool)
        or not isinstance(min_words_per_minute, (int, float))
        or not math.isfinite(float(min_words_per_minute))
        or float(min_words_per_minute) <= 0
    ):
        raise ValueError("Invalid minimum Chatterbox words-per-minute value.")
    if (
        isinstance(max_words_per_minute, bool)
        or not isinstance(max_words_per_minute, (int, float))
        or not math.isfinite(float(max_words_per_minute))
        or float(max_words_per_minute) <= 0
    ):
        raise ValueError("Invalid maximum Chatterbox words-per-minute value.")
    min_words_per_minute = float(min_words_per_minute)
    max_words_per_minute = float(max_words_per_minute)
    if min_words_per_minute >= max_words_per_minute:
        raise ValueError("Chatterbox minimum words per minute must be below the maximum.")
    if not min_words_per_minute <= float(target_words_per_minute) <= max_words_per_minute:
        raise ValueError("Chatterbox words-per-minute limits must include the target rate.")
    if not isinstance(generation, dict):
        raise ValueError("Chatterbox needs generation settings.")
    repetition_penalty = generation.get("repetitionPenalty")
    temperature = generation.get("temperature")
    top_p = generation.get("topP")
    if (
        isinstance(repetition_penalty, bool)
        or not isinstance(repetition_penalty, (int, float))
        or not 1.0 <= float(repetition_penalty) <= 2.0
    ):
        raise ValueError("Invalid Chatterbox repetition penalty.")
    if (
        isinstance(temperature, bool)
        or not isinstance(temperature, (int, float))
        or not 0.1 <= float(temperature) <= 1.5
    ):
        raise ValueError("Invalid Chatterbox temperature.")
    if (
        isinstance(top_p, bool)
        or not isinstance(top_p, (int, float))
        or not 0.1 <= float(top_p) <= 1.0
    ):
        raise ValueError("Invalid Chatterbox top-p value.")
    validated_segments = []
    for segment in segments:
        if not isinstance(segment, dict):
            raise ValueError("Every Chatterbox segment must be an object.")
        text = segment.get("text")
        pause_ms = segment.get("pauseAfterMs")
        if not isinstance(text, str) or not text.strip() or len(text) > 320:
            raise ValueError("Every Chatterbox segment needs bounded narration text.")
        if (
            isinstance(pause_ms, bool)
            or not isinstance(pause_ms, (int, float))
            or not math.isfinite(float(pause_ms))
            or pause_ms < 0
            or pause_ms > 1200
        ):
            raise ValueError("Every Chatterbox pause must be between 0 and 1200 milliseconds.")
        validated_segments.append((text.strip(), int(round(pause_ms))))
    if not isinstance(sample_path, str) or not sample_path:
        raise ValueError("Chatterbox needs a local reference recording.")

    if device == "mps" and not torch.backends.mps.is_available():
        device = "cpu"
    model = ChatterboxTurboTTS.from_pretrained(device=device)
    # A/B testing confirmed exaggeration is inert in pinned Turbo 0.1.7;
    # reverify that behavior before adding it when upgrading Chatterbox.
    model.prepare_conditionals(sample_path)

    parts = []
    for index, (cleaned_text, pause_ms) in enumerate(validated_segments):
        last_error = None
        generated = None
        for attempt in range(3):
            seed = 42 + index * 17 + attempt
            torch.manual_seed(seed)
            candidate = model.generate(
                cleaned_text,
                repetition_penalty=float(repetition_penalty),
                temperature=float(temperature),
                top_p=float(top_p),
            ).detach().cpu()
            duration, word_count, words_per_minute = segment_speech_metrics(
                candidate,
                cleaned_text,
                model.sr,
            )
            try:
                validate_generated_audio(candidate, cleaned_text, model.sr)
                validate_speaking_rate(
                    words_per_minute,
                    min_words_per_minute,
                    max_words_per_minute,
                )
                emit_segment_diagnostic(
                    index=index,
                    attempt=attempt + 1,
                    seed=seed,
                    duration=duration,
                    word_count=word_count,
                    words_per_minute=words_per_minute,
                    min_words_per_minute=min_words_per_minute,
                    max_words_per_minute=max_words_per_minute,
                    status="accepted",
                    text=cleaned_text,
                )
                generated = candidate
                break
            except ValueError as error:
                last_error = error
                emit_segment_diagnostic(
                    index=index,
                    attempt=attempt + 1,
                    seed=seed,
                    duration=duration,
                    word_count=word_count,
                    words_per_minute=words_per_minute,
                    min_words_per_minute=min_words_per_minute,
                    max_words_per_minute=max_words_per_minute,
                    status="rejected",
                    text=cleaned_text,
                    reason=str(error),
                )
        if generated is None:
            raise ValueError(
                f"Chatterbox could not produce clear audio for chunk {index + 1}: {last_error}"
            )
        parts.append(generated)
        if index < len(validated_segments) - 1 and pause_ms > 0:
            pause_samples = int(model.sr * pause_ms / 1000)
            parts.append(torch.zeros((1, pause_samples), dtype=torch.float32))

    torchaudio.save(sys.argv[2], torch.cat(parts, dim=1), model.sr)


if __name__ == "__main__":
    main()
