#!/usr/bin/env python3
"""Local Chatterbox Turbo worker. Its input and output file paths are supplied by SignalCast."""

import json
import sys

import torch
import torchaudio
from chatterbox.tts_turbo import ChatterboxTurboTTS


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
        parts.append(model.generate(text.strip()).detach().cpu())
        if index < len(chunks) - 1:
            parts.append(torch.zeros((1, int(model.sr * 0.28)), dtype=torch.float32))

    torchaudio.save(sys.argv[2], torch.cat(parts, dim=1), model.sr)


if __name__ == "__main__":
    main()
