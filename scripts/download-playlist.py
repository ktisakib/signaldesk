#!/usr/bin/env python3
"""Download only the reviewed NASA programs listed in media/playlist.json.

Install yt-dlp[default] in a Python 3.11+ virtual environment, then run this
script from that environment. FFmpeg, FFprobe, and Node must be on PATH.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "media/playlist.json"


def checked_url(value, hosts):
    url = urlparse(value)
    if url.scheme != "https" or url.hostname not in hosts or url.username or url.password:
        raise ValueError(f"Unapproved source URL: {value}")
    return value


def output_path(value):
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT / "media/videos") or path.suffix != ".mp4":
        raise ValueError("Playlist outputs must be MP4 files inside media/videos")
    return path


def probe(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True, check=True, timeout=30,
    )
    data = json.loads(result.stdout)
    duration = float(data["format"]["duration"])
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    audio = next(s for s in data["streams"] if s["codec_type"] == "audio")
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Downloaded program has an invalid duration")
    if video["codec_name"] != "h264" or audio["codec_name"] != "aac" or video["height"] > 720:
        raise ValueError("Playlist requires H.264/AAC video no taller than 720 pixels")
    return {"durationSeconds": duration, "width": video["width"], "height": video["height"]}


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def save_manifest(data):
    temporary = MANIFEST.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(MANIFEST)


def download(video, folder):
    video = dict(video)
    youtube = checked_url(video["youtubeUrl"], {"www.youtube.com", "youtube.com", "youtu.be"})
    checked_url(video["licenseUrl"], {"svs.gsfc.nasa.gov", "www.nasa.gov", "science.nasa.gov"})
    if video.get("rightsScope") != "complete-program-only":
        raise ValueError("Program has not been reviewed for complete-program redistribution")
    command = [
        sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist", "--no-progress",
        "--js-runtimes", "node", "--socket-timeout", "20", "--retries", "1",
        "--max-filesize", "100M", "--write-info-json", "-o", str(folder / "source.%(ext)s"),
    ]
    result = subprocess.run(command + [
        "-f", "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]",
        "--merge-output-format", "mp4", youtube,
    ], capture_output=True, text=True, timeout=600)
    source = folder / "source.mp4"
    method = "youtube-yt-dlp"
    if result.returncode or not source.is_file():
        # An official creator download is used only after the corresponding YouTube request fails.
        video["youtubeDownloadError"] = (result.stderr or result.stdout)[-1500:].strip()
        fallback = checked_url(video["originalDownloadUrl"], {"svs.gsfc.nasa.gov"})
        for file in folder.glob("source*"):
            file.unlink()
        subprocess.run(command + [fallback], check=True, timeout=600)
        source = next((p for p in folder.glob("source.*") if p.suffix in {".mp4", ".webm", ".mkv"}), None)
        if source is None:
            raise ValueError("Official NASA download produced no video")
        method = "nasa-original-yt-dlp"
    info_path = folder / "source.info.json"
    if method == "youtube-yt-dlp":
        info = json.loads(info_path.read_text(encoding="utf-8"))
        if info.get("channel") not in video["allowedChannels"]:
            raise ValueError(f"Unexpected YouTube creator: {info.get('channel')}")
        video["youtubeTitle"] = info["title"]
        video["youtubeChannel"] = info["channel"]
        video["youtubeChannelUrl"] = info["channel_url"]
        video["youtubeDurationSeconds"] = info["duration"]
    try:
        probe(source)
    except (ValueError, StopIteration):
        converted = folder / "compatible.mp4"
        subprocess.run([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(source),
            "-map", "0:v:0", "-map", "0:a:0", "-vf",
            "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(converted),
        ], check=True, timeout=1800)
        source = converted
    details = probe(source)
    expected = video.get("youtubeDurationSeconds")
    if expected and abs(details["durationSeconds"] - expected) > 2:
        raise ValueError("Downloaded file does not preserve the complete YouTube program duration")
    target = output_path(video["path"])
    source.replace(target)
    video.update(details, sha256=digest(target), sizeBytes=target.stat().st_size, downloadMethod=method)
    return video


def download_program(video):
    target = output_path(video["path"])
    with tempfile.TemporaryDirectory(prefix=".download-", dir=target.parent) as folder:
        return download(video, Path(folder))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="Check local files without downloading")
    args = parser.parse_args()
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    pending = []
    for number, video in enumerate(data["videos"], 1):
        target = output_path(video["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file() and video.get("sha256") == digest(target):
            probe(target)
            print(f"{number}/{len(data['videos'])} verified: {video['title']}", flush=True)
            continue
        if args.verify:
            raise ValueError(f"Missing or changed program: {target}")
        pending.append((number - 1, video))
    errors = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {pool.submit(download_program, video): index for index, video in pending}
        for job in as_completed(jobs):
            index = jobs[job]
            try:
                data["videos"][index] = job.result()
                save_manifest(data)
                print(f"{index + 1}/{len(data['videos'])} downloaded: {data['videos'][index]['title']}", flush=True)
            except Exception as error:
                errors.append(f"{data['videos'][index]['title']}: {error}")
    if errors:
        raise RuntimeError("\n".join(errors))
    print(f"Verified {len(data['videos'])} programs; {sum(v['sizeBytes'] for v in data['videos']):,} bytes.")


if __name__ == "__main__":
    main()
