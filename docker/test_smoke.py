import unittest

from smoke import assert_clean_logs


class StreamWarningTests(unittest.TestCase):
    def test_source_timing_warnings_fail_even_when_decoder_succeeds(self):
        assert_clean_logs({"logs": ["FFmpeg: encoder started"]})
        for warning in ("Non-monotonous DTS", "Non-monotonic DTS", "Queue input is backward in time",
                        "MediaMTX: HLS segment duration changed from 2s to 3s"):
            with self.subTest(warning=warning):
                with self.assertRaisesRegex(AssertionError, "Source stream timing warnings"):
                    assert_clean_logs({"logs": [warning]})


if __name__ == "__main__":
    unittest.main()
