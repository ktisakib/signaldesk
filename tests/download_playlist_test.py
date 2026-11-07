import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("download_playlist", Path(__file__).parents[1] / "scripts/download-playlist.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SourceValidationTests(unittest.TestCase):
    def test_only_reviewed_https_sources(self):
        self.assertEqual(module.checked_url("https://svs.gsfc.nasa.gov/14538/", {"svs.gsfc.nasa.gov"}), "https://svs.gsfc.nasa.gov/14538/")
        for url in ["http://svs.gsfc.nasa.gov/14538/", "https://evil.example/clip.mp4", "https://user@svs.gsfc.nasa.gov/14538/"]:
            with self.assertRaises(ValueError):
                module.checked_url(url, {"svs.gsfc.nasa.gov"})

    def test_download_cannot_write_outside_media(self):
        self.assertEqual(module.output_path("media/videos/clip.mp4"), module.ROOT / "media/videos/clip.mp4")
        for path in ["media/videos/../../clip.mp4", "/tmp/clip.mp4", "media/videos/clip.exe"]:
            with self.assertRaises(ValueError):
                module.output_path(path)

    def test_manifest_keeps_twenty_reviewed_complete_programs(self):
        videos = json.loads(module.MANIFEST.read_text(encoding="utf-8"))["videos"]
        self.assertEqual(len(videos), 20)
        self.assertEqual(len({v["youtubeUrl"] for v in videos}), 20)
        for video in videos:
            module.output_path(video["path"])
            module.checked_url(video["youtubeUrl"], {"www.youtube.com", "youtube.com", "youtu.be"})
            module.checked_url(video["licenseUrl"], {"svs.gsfc.nasa.gov", "www.nasa.gov", "science.nasa.gov"})
            self.assertEqual(video["rightsScope"], "complete-program-only")
            self.assertTrue(video["permissionQuote"])
            self.assertTrue(video["attribution"])


if __name__ == "__main__":
    unittest.main()
