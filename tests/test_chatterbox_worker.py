import contextlib
import io
import json
import unittest

import torch

from scripts.chatterbox_tts import (
    emit_segment_diagnostic,
    segment_speech_metrics,
    should_prefer_slow_fallback,
    slow_fallback_floor_words_per_minute,
    validate_speaking_rate,
)


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
