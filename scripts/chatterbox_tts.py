#!/usr/bin/env python3
"""Local Chatterbox Turbo worker. Its input and output file paths are supplied by KernelZero."""

import hashlib
import json
import math
import os
import re
import sys

import torch
import torchaudio
from chatterbox.tts_turbo import ChatterboxTurboTTS


LEADING_DELIVERY_TAGS = re.compile(
    r"^(?:\[(?:dramatic|happy|narration|surprised)\]\s*)+",
    re.IGNORECASE,
)
FATAL_GENERATION_RUNTIME_ERROR = re.compile(
    r"out of memory|device-side assert|not enough memory|cannot allocate memory|"
    r"can't allocate memory|bad_alloc|errno\s*12",
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


def slow_fallback_floor_words_per_minute(
    min_words_per_minute: float,
    max_tempo_adjustment: float,
) -> float:
    """Lowest clear rate tolerated after retries for natural slow passages."""
    return min_words_per_minute / (1.0 + max_tempo_adjustment)


def should_prefer_slow_fallback(
    candidate_words_per_minute: float,
    current_words_per_minute: float | None,
    min_words_per_minute: float,
    max_tempo_adjustment: float,
) -> bool:
    """Keep the fastest below-limit candidate that bounded speedup can repair."""
    fallback_floor = slow_fallback_floor_words_per_minute(
        min_words_per_minute,
        max_tempo_adjustment,
    )
    return (
        fallback_floor <= candidate_words_per_minute < min_words_per_minute
        and (
            current_words_per_minute is None
            or candidate_words_per_minute > current_words_per_minute
        )
    )


def fast_fallback_ceiling_words_per_minute(
    max_words_per_minute: float,
    max_tempo_adjustment: float,
) -> float:
    """Highest clear rate tolerated after retries, symmetric with slow audio."""
    return max_words_per_minute * (1.0 + max_tempo_adjustment)


def should_prefer_fast_fallback(
    candidate_words_per_minute: float,
    current_words_per_minute: float | None,
    max_words_per_minute: float,
    max_tempo_adjustment: float,
) -> bool:
    """Keep the slowest over-limit candidate within the bounded tolerance."""
    fallback_ceiling = fast_fallback_ceiling_words_per_minute(
        max_words_per_minute,
        max_tempo_adjustment,
    )
    return (
        max_words_per_minute < candidate_words_per_minute <= fallback_ceiling
        and (
            current_words_per_minute is None
            or candidate_words_per_minute < current_words_per_minute
        )
    )


def speaking_rate_distance_to_range(
    words_per_minute: float,
    min_words_per_minute: float,
    max_words_per_minute: float,
) -> float:
    if words_per_minute < min_words_per_minute:
        return min_words_per_minute - words_per_minute
    if words_per_minute > max_words_per_minute:
        return words_per_minute - max_words_per_minute
    return 0.0


def should_prefer_bounded_fallback(
    candidate_words_per_minute: float,
    current_words_per_minute: float | None,
    min_words_per_minute: float,
    max_words_per_minute: float,
    max_tempo_adjustment: float,
) -> bool:
    """Choose the clear, repairable candidate closest to the valid range."""
    eligible = should_prefer_slow_fallback(
        candidate_words_per_minute,
        None,
        min_words_per_minute,
        max_tempo_adjustment,
    ) or should_prefer_fast_fallback(
        candidate_words_per_minute,
        None,
        max_words_per_minute,
        max_tempo_adjustment,
    )
    if not eligible:
        return False
    if current_words_per_minute is None:
        return True
    candidate_distance = speaking_rate_distance_to_range(
        candidate_words_per_minute,
        min_words_per_minute,
        max_words_per_minute,
    )
    current_distance = speaking_rate_distance_to_range(
        current_words_per_minute,
        min_words_per_minute,
        max_words_per_minute,
    )
    if candidate_distance != current_distance:
        return candidate_distance < current_distance
    midpoint = (min_words_per_minute + max_words_per_minute) / 2.0
    return abs(candidate_words_per_minute - midpoint) < abs(
        current_words_per_minute - midpoint
    )


def recovery_generation_settings(
    temperature: float,
    top_p: float,
) -> tuple[float, float]:
    """Use one calmer, less variable attempt after strict retries are exhausted."""
    return max(0.1, temperature * 0.75), max(0.1, min(top_p, 0.85))


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
    if samples.numel() == 0 or not bool(torch.isfinite(samples).all()):
        raise ValueError("Chatterbox produced empty or non-finite audio.")
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


def generate_segment_attempt(
    *,
    model,
    text: str,
    index: int,
    attempt: int,
    seed: int,
    repetition_penalty: float,
    temperature: float,
    top_p: float,
    min_words_per_minute: float,
    max_words_per_minute: float,
    accepted_status: str,
    rejected_status: str,
) -> tuple[
    torch.Tensor | None,
    tuple[torch.Tensor, int, int, float, int, float] | None,
    Exception | None,
]:
    """Generate once, keeping clear rate-only failures eligible for fallback."""
    candidate = None
    duration = 0.0
    word_count = 0
    words_per_minute = math.inf
    clear_audio = False
    try:
        torch.manual_seed(seed)
        candidate = model.generate(
            text,
            repetition_penalty=repetition_penalty,
            temperature=temperature,
            top_p=top_p,
        ).detach().cpu()
        duration, word_count, words_per_minute = segment_speech_metrics(
            candidate,
            text,
            model.sr,
        )
        validate_generated_audio(candidate, text, model.sr)
        clear_audio = True
        validate_speaking_rate(
            words_per_minute,
            min_words_per_minute,
            max_words_per_minute,
        )
    except (RuntimeError, ValueError) as error:
        if isinstance(error, RuntimeError) and FATAL_GENERATION_RUNTIME_ERROR.search(
            str(error)
        ):
            raise
        emit_segment_diagnostic(
            index=index,
            attempt=attempt,
            seed=seed,
            duration=duration,
            word_count=word_count,
            words_per_minute=words_per_minute,
            min_words_per_minute=min_words_per_minute,
            max_words_per_minute=max_words_per_minute,
            status=rejected_status,
            text=text,
            reason=str(error),
        )
        fallback_candidate = (
            (candidate, attempt, seed, duration, word_count, words_per_minute)
            if clear_audio and candidate is not None
            else None
        )
        return None, fallback_candidate, error

    emit_segment_diagnostic(
        index=index,
        attempt=attempt,
        seed=seed,
        duration=duration,
        word_count=word_count,
        words_per_minute=words_per_minute,
        min_words_per_minute=min_words_per_minute,
        max_words_per_minute=max_words_per_minute,
        status=accepted_status,
        text=text,
    )
    return candidate, None, None


def accept_bounded_fallback(
    *,
    fallback: tuple[torch.Tensor, int, int, float, int, float],
    index: int,
    text: str,
    min_words_per_minute: float,
    max_words_per_minute: float,
    max_tempo_adjustment: float,
) -> torch.Tensor:
    (
        generated,
        fallback_attempt,
        fallback_seed,
        fallback_duration,
        fallback_word_count,
        fallback_words_per_minute,
    ) = fallback
    is_slow = fallback_words_per_minute < min_words_per_minute
    emit_segment_diagnostic(
        index=index,
        attempt=fallback_attempt,
        seed=fallback_seed,
        duration=fallback_duration,
        word_count=fallback_word_count,
        words_per_minute=fallback_words_per_minute,
        min_words_per_minute=min_words_per_minute,
        max_words_per_minute=max_words_per_minute,
        status=(
            "accepted_slow_fallback" if is_slow else "accepted_fast_fallback"
        ),
        text=text,
        reason=(
            "Clear audio selected after retries as the "
            f"{'fastest below-limit' if is_slow else 'slowest over-limit'} "
            f"candidate within the bounded {max_tempo_adjustment:.0%} "
            f"{'slow' if is_slow else 'fast'}-rate tolerance."
        ),
    )
    return generated


def generate_validated_segment(
    *,
    model,
    text: str,
    index: int,
    retry_epoch: int,
    repetition_penalty: float,
    temperature: float,
    top_p: float,
    min_words_per_minute: float,
    max_words_per_minute: float,
    max_tempo_adjustment: float,
) -> torch.Tensor:
    """Generate one segment with strict retries, fallback, then one recovery pass."""
    last_error: Exception | None = None
    fallback = None
    seed_base = 42 + index * 17 + retry_epoch * 1009
    for attempt in range(1, 4):
        generated, candidate, error = generate_segment_attempt(
            model=model,
            text=text,
            index=index,
            attempt=attempt,
            seed=seed_base + attempt - 1,
            repetition_penalty=repetition_penalty,
            temperature=temperature,
            top_p=top_p,
            min_words_per_minute=min_words_per_minute,
            max_words_per_minute=max_words_per_minute,
            accepted_status="accepted",
            rejected_status="rejected",
        )
        if generated is not None:
            return generated
        last_error = error or last_error
        if candidate is not None and should_prefer_bounded_fallback(
            candidate[5],
            fallback[5] if fallback is not None else None,
            min_words_per_minute,
            max_words_per_minute,
            max_tempo_adjustment,
        ):
            fallback = candidate

    if fallback is not None:
        return accept_bounded_fallback(
            fallback=fallback,
            index=index,
            text=text,
            min_words_per_minute=min_words_per_minute,
            max_words_per_minute=max_words_per_minute,
            max_tempo_adjustment=max_tempo_adjustment,
        )

    recovery_temperature, recovery_top_p = recovery_generation_settings(
        temperature,
        top_p,
    )
    generated, candidate, error = generate_segment_attempt(
        model=model,
        text=text,
        index=index,
        attempt=4,
        seed=seed_base + 3,
        repetition_penalty=repetition_penalty,
        temperature=recovery_temperature,
        top_p=recovery_top_p,
        min_words_per_minute=min_words_per_minute,
        max_words_per_minute=max_words_per_minute,
        accepted_status="accepted_recovery",
        rejected_status="recovery_rejected",
    )
    if generated is not None:
        return generated
    last_error = error or last_error
    if candidate is not None and should_prefer_bounded_fallback(
        candidate[5],
        None,
        min_words_per_minute,
        max_words_per_minute,
        max_tempo_adjustment,
    ):
        return accept_bounded_fallback(
            fallback=candidate,
            index=index,
            text=text,
            min_words_per_minute=min_words_per_minute,
            max_words_per_minute=max_words_per_minute,
            max_tempo_adjustment=max_tempo_adjustment,
        )
    raise ValueError(
        f"Chatterbox could not produce clear audio for chunk {index + 1}: {last_error}"
    )


def checkpoint_fingerprint(request: dict) -> str:
    fingerprinted = {
        key: value
        for key, value in request.items()
        if key not in {"checkpointDir", "retryEpoch"}
    }
    sample_path = fingerprinted.get("samplePath")
    if isinstance(sample_path, str):
        try:
            sample_stat = os.stat(sample_path)
            fingerprinted["sampleIdentity"] = {
                "path": os.path.realpath(sample_path),
                "size": sample_stat.st_size,
                "modifiedNanoseconds": sample_stat.st_mtime_ns,
            }
        except OSError:
            fingerprinted["sampleIdentity"] = {"path": os.path.realpath(sample_path)}
    payload = json.dumps(
        fingerprinted,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def prepare_checkpoint_directory(checkpoint_dir: str, fingerprint: str) -> None:
    os.makedirs(checkpoint_dir, exist_ok=True)
    manifest_path = os.path.join(checkpoint_dir, "manifest.json")
    existing_fingerprint = None
    try:
        with open(manifest_path, "r", encoding="utf-8") as manifest_file:
            manifest = json.load(manifest_file)
        existing_fingerprint = manifest.get("fingerprint")
    except (OSError, ValueError, AttributeError):
        pass
    if existing_fingerprint != fingerprint:
        for name in os.listdir(checkpoint_dir):
            if re.fullmatch(r"segment-\d{4}\.wav", name):
                try:
                    os.unlink(os.path.join(checkpoint_dir, name))
                except FileNotFoundError:
                    pass
        temporary_manifest = f"{manifest_path}.tmp-{os.getpid()}"
        with open(temporary_manifest, "w", encoding="utf-8") as manifest_file:
            json.dump({"fingerprint": fingerprint}, manifest_file)
        os.replace(temporary_manifest, manifest_path)


def save_segment_checkpoint(
    checkpoint_path: str,
    wav: torch.Tensor,
    sample_rate: int,
) -> None:
    temporary_path = f"{checkpoint_path}.tmp-{os.getpid()}.wav"
    torchaudio.save(temporary_path, wav, sample_rate, format="wav")
    os.replace(temporary_path, checkpoint_path)


def load_segment_checkpoint(
    checkpoint_path: str,
    text: str,
    sample_rate: int,
) -> torch.Tensor | None:
    try:
        wav, cached_sample_rate = torchaudio.load(checkpoint_path)
        if cached_sample_rate != sample_rate:
            raise ValueError("Cached Chatterbox sample rate does not match the model.")
        validate_generated_audio(wav, text, sample_rate)
        return wav
    except (OSError, RuntimeError, ValueError):
        try:
            os.unlink(checkpoint_path)
        except FileNotFoundError:
            pass
        return None


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
    max_tempo_adjustment = request.get("maxTempoAdjustment", 0.15)
    checkpoint_dir = request.get("checkpointDir")
    retry_epoch = request.get("retryEpoch", 0)
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
    if (
        isinstance(max_tempo_adjustment, bool)
        or not isinstance(max_tempo_adjustment, (int, float))
        or not math.isfinite(float(max_tempo_adjustment))
        or not 0 <= float(max_tempo_adjustment) <= 0.15
    ):
        raise ValueError("Invalid maximum Chatterbox tempo adjustment.")
    min_words_per_minute = float(min_words_per_minute)
    max_words_per_minute = float(max_words_per_minute)
    max_tempo_adjustment = float(max_tempo_adjustment)
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
    if not isinstance(checkpoint_dir, str) or not checkpoint_dir.strip():
        raise ValueError("Chatterbox needs a segment checkpoint directory.")
    if (
        isinstance(retry_epoch, bool)
        or not isinstance(retry_epoch, int)
        or not 0 <= retry_epoch <= 3
    ):
        raise ValueError("Invalid Chatterbox retry epoch.")

    if device == "mps" and not torch.backends.mps.is_available():
        device = "cpu"
    model = ChatterboxTurboTTS.from_pretrained(device=device)
    # A/B testing confirmed exaggeration is inert in pinned Turbo 0.1.7;
    # reverify that behavior before adding it when upgrading Chatterbox.
    model.prepare_conditionals(sample_path)
    prepare_checkpoint_directory(
        checkpoint_dir,
        checkpoint_fingerprint(request),
    )

    parts = []
    for index, (cleaned_text, pause_ms) in enumerate(validated_segments):
        checkpoint_path = os.path.join(
            checkpoint_dir,
            f"segment-{index:04d}.wav",
        )
        generated = load_segment_checkpoint(
            checkpoint_path,
            cleaned_text,
            model.sr,
        )
        if generated is not None:
            duration, word_count, words_per_minute = segment_speech_metrics(
                generated,
                cleaned_text,
                model.sr,
            )
            emit_segment_diagnostic(
                index=index,
                attempt=0,
                seed=0,
                duration=duration,
                word_count=word_count,
                words_per_minute=words_per_minute,
                min_words_per_minute=min_words_per_minute,
                max_words_per_minute=max_words_per_minute,
                status="reused_checkpoint",
                text=cleaned_text,
            )
        else:
            generated = generate_validated_segment(
                model=model,
                text=cleaned_text,
                index=index,
                retry_epoch=retry_epoch,
                repetition_penalty=float(repetition_penalty),
                temperature=float(temperature),
                top_p=float(top_p),
                min_words_per_minute=min_words_per_minute,
                max_words_per_minute=max_words_per_minute,
                max_tempo_adjustment=max_tempo_adjustment,
            )
            save_segment_checkpoint(
                checkpoint_path,
                generated,
                model.sr,
            )
        parts.append(generated)
        if index < len(validated_segments) - 1 and pause_ms > 0:
            pause_samples = int(model.sr * pause_ms / 1000)
            parts.append(torch.zeros((1, pause_samples), dtype=torch.float32))

    temporary_output = f"{sys.argv[2]}.tmp-{os.getpid()}.wav"
    torchaudio.save(
        temporary_output,
        torch.cat(parts, dim=1),
        model.sr,
        format="wav",
    )
    os.replace(temporary_output, sys.argv[2])


if __name__ == "__main__":
    main()
