import contextlib
import io
import json
import os
import tempfile
import unittest

import torch

from scripts.chatterbox_tts import (
    checkpoint_fingerprint,
    emit_segment_diagnostic,
    fast_fallback_ceiling_words_per_minute,
    generate_validated_segment,
    load_segment_checkpoint,
    prepare_checkpoint_directory,
    recovery_generation_settings,
    save_segment_checkpoint,
    segment_speech_metrics,
    should_prefer_bounded_fallback,
    should_prefer_fast_fallback,
    should_prefer_slow_fallback,
    slow_fallback_floor_words_per_minute,
    validate_generated_audio,
    validate_speaking_rate,
)


TEST_TEXT = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"


def waveform_for_rate(words_per_minute: float, sample_rate: int = 1_000) -> torch.Tensor:
    duration = len(TEST_TEXT.split()) * 60.0 / words_per_minute
    return torch.full((1, round(duration * sample_rate)), 0.1)


class FakeModel:
    sr = 1_000

    def __init__(self, outcomes) -> None:
        self.outcomes = list(outcomes)
        self.calls = []

    def generate(self, text: str, **settings):
        self.calls.append({"text": text, **settings})
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class ChatterboxWorkerTests(unittest.TestCase):
    def test_segment_metrics_strip_supported_delivery_tags(self) -> None:
        wav = torch.zeros(24_000)

        duration, word_count, words_per_minute = segment_speech_metrics(
            wav,
            "[happy] [surprised] one two three",
            24_000,
        )

        self.assertEqual(duration, 1.0)
        self.assertEqual(word_count, 3)
        self.assertEqual(words_per_minute, 180.0)

    def test_speaking_rate_bounds_are_inclusive(self) -> None:
        validate_speaking_rate(130.0, 130.0, 190.0)
        validate_speaking_rate(190.0, 130.0, 190.0)
        with self.assertRaisesRegex(ValueError, "130-190 WPM"):
            validate_speaking_rate(129.9, 130.0, 190.0)
        with self.assertRaisesRegex(ValueError, "130-190 WPM"):
            validate_speaking_rate(190.1, 130.0, 190.0)

    def test_slow_fallback_selects_fastest_bounded_candidate(self) -> None:
        minimum = slow_fallback_floor_words_per_minute(130.0, 0.15)

        self.assertAlmostEqual(minimum, 113.043478, places=5)
        selected = None
        for rate in (123.4, 105.6, 114.9):
            if should_prefer_slow_fallback(rate, selected, 130.0, 0.15):
                selected = rate

        self.assertEqual(selected, 123.4)

    def test_slow_fallback_never_accepts_fast_or_excessively_slow_audio(self) -> None:
        self.assertFalse(
            should_prefer_slow_fallback(105.6, None, 130.0, 0.15)
        )
        self.assertFalse(
            should_prefer_slow_fallback(190.1, None, 130.0, 0.15)
        )
        self.assertFalse(
            should_prefer_slow_fallback(200.0, None, 130.0, 0.15)
        )

    def test_fast_fallback_selects_slowest_near_limit_candidate(self) -> None:
        maximum = fast_fallback_ceiling_words_per_minute(190.0, 0.15)

        self.assertAlmostEqual(maximum, 218.5, places=5)
        selected = None
        for rate in (205.0, 202.1, 197.9):
            if should_prefer_fast_fallback(rate, selected, 190.0, 0.15):
                selected = rate

        self.assertEqual(selected, 197.9)

    def test_fast_fallback_never_accepts_in_range_or_wildly_fast_audio(self) -> None:
        self.assertFalse(
            should_prefer_fast_fallback(190.0, None, 190.0, 0.15)
        )
        self.assertFalse(
            should_prefer_fast_fallback(218.6, None, 190.0, 0.15)
        )
        self.assertFalse(
            should_prefer_fast_fallback(260.0, None, 190.0, 0.15)
        )

    def test_bounded_fallback_chooses_closest_candidate_from_either_side(self) -> None:
        selected = None
        for rate in (114.0, 205.0, 197.9):
            if should_prefer_bounded_fallback(
                rate,
                selected,
                130.0,
                190.0,
                0.15,
            ):
                selected = rate

        self.assertEqual(selected, 197.9)

    def test_fast_fallback_rescues_the_logged_converging_attempts(self) -> None:
        model = FakeModel(
            [
                waveform_for_rate(205.0),
                waveform_for_rate(202.1),
                waveform_for_rate(197.9),
            ]
        )
        stderr = io.StringIO()

        with contextlib.redirect_stderr(stderr):
            generated = generate_validated_segment(
                model=model,
                text=TEST_TEXT,
                index=9,
                retry_epoch=0,
                repetition_penalty=1.2,
                temperature=0.8,
                top_p=0.95,
                min_words_per_minute=130.0,
                max_words_per_minute=190.0,
                max_tempo_adjustment=0.15,
            )

        self.assertEqual(len(model.calls), 3)
        self.assertEqual(generated.numel(), waveform_for_rate(197.9).numel())
        self.assertIn('"status":"accepted_fast_fallback"', stderr.getvalue())

    def test_transient_failure_uses_one_calmer_recovery_attempt(self) -> None:
        model = FakeModel(
            [
                RuntimeError("temporary decoder failure"),
                waveform_for_rate(260.0),
                waveform_for_rate(250.0),
                waveform_for_rate(160.0),
            ]
        )

        generated = generate_validated_segment(
            model=model,
            text=TEST_TEXT,
            index=2,
            retry_epoch=1,
            repetition_penalty=1.2,
            temperature=0.8,
            top_p=0.95,
            min_words_per_minute=130.0,
            max_words_per_minute=190.0,
            max_tempo_adjustment=0.15,
        )

        self.assertEqual(len(model.calls), 4)
        self.assertEqual(generated.numel(), waveform_for_rate(160.0).numel())
        self.assertAlmostEqual(model.calls[-1]["temperature"], 0.6)
        self.assertAlmostEqual(model.calls[-1]["top_p"], 0.85)
        recovery_temperature, recovery_top_p = recovery_generation_settings(0.8, 0.95)
        self.assertAlmostEqual(recovery_temperature, 0.6)
        self.assertAlmostEqual(recovery_top_p, 0.85)

    def test_permanent_segment_failure_stops_after_four_attempts(self) -> None:
        model = FakeModel([waveform_for_rate(260.0)] * 4)

        with self.assertRaisesRegex(ValueError, "chunk 1"):
            generate_validated_segment(
                model=model,
                text=TEST_TEXT,
                index=0,
                retry_epoch=0,
                repetition_penalty=1.2,
                temperature=0.8,
                top_p=0.95,
                min_words_per_minute=130.0,
                max_words_per_minute=190.0,
                max_tempo_adjustment=0.15,
            )

        self.assertEqual(len(model.calls), 4)

    def test_cpu_allocator_oom_is_rethrown_without_retries(self) -> None:
        model = FakeModel(
            [RuntimeError("DefaultCPUAllocator: can't allocate memory")]
        )

        with self.assertRaisesRegex(RuntimeError, "can't allocate memory"):
            generate_validated_segment(
                model=model,
                text=TEST_TEXT,
                index=0,
                retry_epoch=0,
                repetition_penalty=1.2,
                temperature=0.8,
                top_p=0.95,
                min_words_per_minute=130.0,
                max_words_per_minute=190.0,
                max_tempo_adjustment=0.15,
            )

        self.assertEqual(len(model.calls), 1)

    def test_empty_and_non_finite_audio_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "empty or non-finite"):
            validate_generated_audio(torch.tensor([]), TEST_TEXT, 1_000)
        with self.assertRaisesRegex(ValueError, "empty or non-finite"):
            validate_generated_audio(
                torch.tensor([[0.1, float("nan")]]),
                TEST_TEXT,
                1_000,
            )

    def test_segment_checkpoints_are_validated_and_fingerprint_scoped(self) -> None:
        request = {
            "segments": [{"text": TEST_TEXT, "pauseAfterMs": 200}],
            "samplePath": "/tmp/reference.wav",
            "generation": {"temperature": 0.8},
            "retryEpoch": 0,
        }
        with tempfile.TemporaryDirectory() as checkpoint_dir:
            fingerprint = checkpoint_fingerprint(request)
            prepare_checkpoint_directory(checkpoint_dir, fingerprint)
            checkpoint_path = os.path.join(checkpoint_dir, "segment-0000.wav")
            original = waveform_for_rate(160.0)
            save_segment_checkpoint(checkpoint_path, original, 1_000)

            loaded = load_segment_checkpoint(checkpoint_path, TEST_TEXT, 1_000)
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded.shape, original.shape)

            retry_request = {**request, "retryEpoch": 1}
            retry_fingerprint = checkpoint_fingerprint(retry_request)
            self.assertEqual(retry_fingerprint, fingerprint)
            prepare_checkpoint_directory(checkpoint_dir, retry_fingerprint)
            self.assertTrue(os.path.exists(checkpoint_path))

            prepare_checkpoint_directory(checkpoint_dir, "different-fingerprint")
            self.assertFalse(os.path.exists(checkpoint_path))

    def test_diagnostic_is_prefixed_compact_json_with_text(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            emit_segment_diagnostic(
                index=2,
                attempt=1,
                seed=76,
                duration=3.0,
                word_count=8,
                words_per_minute=160.0,
                min_words_per_minute=130.0,
                max_words_per_minute=190.0,
                status="accepted",
                text="A bounded narration chunk.",
            )

        output = stderr.getvalue().strip()
        self.assertTrue(output.startswith("[chatterbox] "))
        diagnostic = json.loads(output.removeprefix("[chatterbox] "))
        self.assertEqual(diagnostic["status"], "accepted")
        self.assertEqual(diagnostic["text"], "A bounded narration chunk.")
        self.assertEqual(diagnostic["wordsPerMinute"], 160.0)


if __name__ == "__main__":
    unittest.main()
