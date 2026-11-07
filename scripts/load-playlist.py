#!/usr/bin/env python3
"""Load the 20 reviewed local videos into the Docker studio; optionally start playout."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://localhost:8080"


def container_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or path.parts[:2] != ("media", "videos") or ".." in path.parts or path.suffix != ".mp4":
        raise ValueError("Playlist files must be MP4s inside media/videos")
    return "/" + str(path)


def api(path, method="GET", body=None):
    request = urllib.request.Request(
        BASE + path, method=method,
        headers={"Content-Type": "application/json", "Origin": BASE},
        data=json.dumps(body).encode() if body is not None else None,
    )
    with urllib.request.urlopen(request, timeout=40) as response:
        return json.load(response)


def load_playlist(start=False):
    if api("/api/status")["state"] not in {"idle", "error"}:
        raise RuntimeError("Stop the current broadcast before replacing its queue")
    videos = json.loads((ROOT / "media/playlist.json").read_text(encoding="utf-8"))["videos"]
    if len(videos) != 20 or len({item["youtubeUrl"] for item in videos}) != 20:
        raise ValueError("Expected 20 distinct reviewed programs")
    for video in videos:
        container_path(video["path"])
        path = (ROOT / video["path"]).resolve()
        if not path.is_relative_to(ROOT / "media/videos") or not path.is_file():
            raise ValueError(f"Missing local video: {video['path']}")
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if digest != video["sha256"] or video["rightsScope"] != "complete-program-only":
            raise ValueError(f"Video hash or reviewed permission is invalid: {video['title']}")
    ids = []
    for number, video in enumerate(videos, 1):
        item = api("/api/library", "POST", {"path": container_path(video["path"])})
        ids.append(item["id"])
        print(f"{number}/20 imported: {video['title']}", flush=True)
    settings = api("/api/settings")
    settings["loopQueue"] = True
    api("/api/settings", "PUT", settings)
    queue = api("/api/queue", "PUT", {"ids": ids})
    assert [item["id"] for item in queue] == ids, "Saved queue order does not match the playlist"
    print("Saved 20 programs in order with continuous looping.", flush=True)
    if start:
        api("/api/broadcast/start", "POST", {"source": "queue"})
        print("Playout requested. The studio shows preparation progress before going live.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", action="store_true", help="Start the saved queue after importing")
    args = parser.parse_args()
    try:
        load_playlist(args.start)
    except urllib.error.HTTPError as error:
        parser.exit(1, error.read().decode() + "\n")
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, str(error) + "\n")
