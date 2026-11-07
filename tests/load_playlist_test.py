import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("load_playlist", Path(__file__).parents[1] / "scripts/load-playlist.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PlaylistLoadingTests(unittest.TestCase):
    def test_container_paths_reject_traversal_and_unmounted_files(self):
        self.assertEqual(module.container_path("media/videos/A program.mp4"), "/media/videos/A program.mp4")
        for path in ["/tmp/clip.mp4", "media/videos/../../clip.mp4", "media/uploads/clip.mp4", "media/videos/clip.txt"]:
            with self.assertRaises(ValueError):
                module.container_path(path)

    def test_active_broadcast_is_not_replaced(self):
        with patch.object(module, "api", return_value={"state": "live"}) as api:
            with self.assertRaisesRegex(RuntimeError, "Stop the current broadcast"):
                module.load_playlist(start=True)
            api.assert_called_once_with("/api/status")


if __name__ == "__main__":
    unittest.main()
