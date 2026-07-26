#!/usr/bin/env python3
"""Local Chatterbox Turbo worker. Its input and output file paths are supplied by SignalCast."""

import json
import math
import sys

import torch
import torchaudio
from chatterbox.tts_turbo import ChatterboxTurboTTS


def validate_generated_audio(wav: torch.Tensor, text: str, sample_rate: int) -> None:
    """Reject silent, mostly silent, clipped, or implausibly long model output."""
    samples = wav.flatten().float()
    duration = samples.numel() / sample_rate
    word_count = max(1, len(text.split()))
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

    chunks = request.get("chunks")
    sample_path = request.get("samplePath")
    device = request.get("device", "mps")
    if not isinstance(chunks, list) or not chunks or not all(isinstance(chunk, str) and chunk.strip() for chunk in chunks):
        raise ValueError("Chatterbox needs at least one non-empty narration chunk.")
    if not isinstance(sample_path, str) or not sample_path:
        raise ValueError("Chatterbox needs a local reference recording.")

    if device == "mps" and not torch.backends.mps.is_available():
        device = "cpu"
    model = ChatterboxTurboTTS.from_pretrained(device=device)
    model.prepare_conditionals(sample_path)

    parts = []
    for index, text in enumerate(chunks):
        cleaned_text = text.strip()
        last_error = None
        generated = None
        for attempt in range(3):
            torch.manual_seed(42 + index * 17 + attempt)
            candidate = model.generate(cleaned_text).detach().cpu()
            try:
                validate_generated_audio(candidate, cleaned_text, model.sr)
                generated = candidate
                break
            except ValueError as error:
                last_error = error
        if generated is None:
            raise ValueError(
                f"Chatterbox could not produce clear audio for chunk {index + 1}: {last_error}"
            )
        parts.append(generated)
        if index < len(chunks) - 1:
            parts.append(torch.zeros((1, int(model.sr * 0.28)), dtype=torch.float32))

    torchaudio.save(sys.argv[2], torch.cat(parts, dim=1), model.sr)


if __name__ == "__main__":
    main()
