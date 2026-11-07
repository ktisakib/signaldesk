#!/usr/bin/env python3
"""Real FFmpeg/MediaMTX smoke test. Run after cargo build -p broadcast-service.

Uses a temporary library and refuses to share a running control service. Install
FFmpeg, FFprobe and MediaMTX on PATH, or set BROADCAST_BIN_DIR to their folder.
"""

from pathlib import Path
import json
import base64
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import struct
import zlib
import urllib.error
import urllib.request
import urllib.parse


ROOT = Path(__file__).resolve().parents[1]
ADDRESS = "http://127.0.0.1:9780"
HLS = os.environ.get("SIGNALDESK_SMOKE_HLS", "http://127.0.0.1:8888")
RTSP_PORT = int(os.environ.get("SIGNALDESK_SMOKE_RTSP_PORT", "8554"))
SUFFIX = ".exe" if os.name == "nt" else ""


def tool(name):
    installed = Path(os.environ.get("BROADCAST_BIN_DIR", "")) / (name + SUFFIX)
    found = str(installed.resolve()) if installed.is_file() else shutil.which(name)
    if not found:
        raise RuntimeError(f"{name} is missing. Install the streaming runtime first.")
    return found


def api(path, method="GET", body=None):
    request = urllib.request.Request(
        ADDRESS + path,
        data=json.dumps(body or {}).encode() if method != "GET" else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error


def wait_live():
    for _ in range(150):
        status = api("/api/status")
        if status["state"] == "live":
            return status
        if status["state"] == "error":
            raise RuntimeError(json.dumps(status))
        time.sleep(0.2)
    raise RuntimeError("Broadcast did not become live within 30 seconds")


def run_smoke(folder, ffmpeg, ffprobe):
    def encode(args):
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)

    first_path = folder / "short audio.mp4"
    second_path = folder / "silent 'clip.avi"
    encode(["-f", "lavfi", "-i", "color=c=red:size=320x240:rate=30:duration=4",
            "-f", "lavfi", "-i", "sine=frequency=880:duration=2", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-c:a", "aac", str(first_path)])
    encode(["-f", "lavfi", "-i", "color=c=blue:size=640x360:rate=24:duration=5",
            "-c:v", "mpeg4", str(second_path)])
    settings = api("/api/settings")
    settings.update(hlsPort=urllib.parse.urlparse(HLS).port or 8888, rtspPort=RTSP_PORT)
    api("/api/settings", "PUT", settings)
    diagnostics = api("/api/diagnostics")
    for name in ("ffmpeg", "ffprobe", "mediamtx"):
        assert diagnostics[name]["available"], f"Engine could not find {name}"
    api("/api/broadcast/start", "POST", {"source": "test"})
    wait_live()
    with urllib.request.urlopen(HLS + "/live/index.m3u8", timeout=20) as response:
        assert "#EXTM3U" in response.read().decode()
    print("PASS: real test signal produces an HLS manifest", flush=True)
    # Exercise live changes through the encoded program, not only the preview.
    graphics = api("/api/graphics/config")
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    logo = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 6, 0, 0, 0))
    logo += chunk(b"IDAT", zlib.compress((b"\0" + b"\xff\xff\xff\xff" * 64) * 64)) + chunk(b"IEND", b"")
    graphics.update(enabled=True, lowerThirdEnabled=True, lowerTitle="Live news / সংবাদ",
                    tickerEnabled=True, bannerLabel="JOBS", tickerText="News and announcements • We are hiring",
                    logoEnabled=True, logoCorner="left", logoWidth=64,
                    logoDataUrl="data:image/png;base64," + base64.b64encode(logo).decode())
    api("/api/graphics/config", "PUT", graphics)
    def white_pixel(x):
        result = subprocess.run([ffmpeg, "-v", "error", "-rtsp_transport", "tcp", "-i", f"rtsp://127.0.0.1:{RTSP_PORT}/live",
                                 "-vf", f"crop=2:2:{x}:70", "-frames:v", "1", "-an", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
                                capture_output=True, timeout=20, check=True)
        assert len(result.stdout) == 12
        return all(channel > 220 for channel in result.stdout)
    time.sleep(1)
    assert white_pixel(60), "Logo did not appear in the encoded left corner"
    a = api("/api/graphics/preview")["image"]
    time.sleep(.3)
    assert a != api("/api/graphics/preview")["image"], "Ticker is not moving"
    graphics["logoCorner"] = "right"
    api("/api/graphics/config", "PUT", graphics)
    time.sleep(1)
    assert white_pixel(1180), "Live logo position change did not reach the encoded stream"
    assert not white_pixel(60), "Old logo remained after moving corners"
    graphics["enabled"] = False
    api("/api/graphics/config", "PUT", graphics)
    time.sleep(1)
    assert not white_pixel(1180), "Graphics did not hide on the encoded stream"
    print("PASS: animated graphics, Bengali text, live logo corner changes and hide reach the encoded program", flush=True)
    api("/api/broadcast/stop", "POST")
    assert api("/api/status")["state"] == "idle"

    first = api("/api/library", "POST", {"path": str(first_path)})
    second = api("/api/library", "POST", {"path": str(second_path)})
    assert first["hasAudio"] and not second["hasAudio"]
    api("/api/queue", "PUT", {"ids": [first["id"], second["id"]]})
    api("/api/broadcast/start", "POST", {"source": "queue"})
    wait_live()
    cache = list((folder / "data" / "cache").glob("*.ts"))
    assert len(cache) == 2
    durations = []
    for file in cache:
        probe = json.loads(subprocess.check_output([
            ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(file)]))
        durations.append(float(probe["format"]["duration"]))
        assert {stream["codec_type"] for stream in probe["streams"]} == {"video", "audio"}
        video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
        assert (video["width"], video["height"]) == (1280, 720)
    assert min(durations) > 3.8, "Short audio truncated the source video"
    print("PASS: mixed frame rates, sizes, codecs and silent media normalize with full duration", flush=True)

    decoder = subprocess.Popen([
        ffmpeg, "-hide_banner", "-loglevel", "warning", "-xerror", "-progress", "pipe:1",
        "-i", HLS + "/live/index.m3u8", "-t", "22",
        "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        titles = set()
        started = time.monotonic()
        while decoder.poll() is None and time.monotonic() - started < 45:
            status = api("/api/status")
            assert status["state"] == "live", status
            titles.add(status["currentTitle"])
            time.sleep(0.4)
        stdout, stderr = decoder.communicate(timeout=10)
        assert decoder.returncode == 0, stderr.decode()
        timestamps = [int(line.split("=", 1)[1]) for line in stdout.decode().splitlines()
                      if line.startswith("out_time_us=") and line.split("=", 1)[1].lstrip("-").isdigit()]
        assert timestamps and max(timestamps) >= 21_500_000, stdout.decode()
        assert len(titles) == 2, titles
        timing_warnings = ("non-monotonous", "non-monotonic", "backward in time", "segment duration changed")
        warnings = [line for line in [*api("/api/status")["logs"], *stderr.decode().splitlines()]
                    if any(pattern in line.lower() for pattern in timing_warnings)]
        assert not warnings, "Source stream timing warnings: " + "\n".join(warnings)
        print("PASS: decoded 22 seconds of continuous HLS across more than two queue loops", flush=True)
    finally:
        if decoder.poll() is None:
            decoder.kill()
        decoder.wait()
    api("/api/broadcast/stop", "POST")
    assert api("/api/status")["state"] == "idle"
    print("PASS: stop returns the engine to idle", flush=True)


def main():
    service_path = Path(os.environ.get("SIGNALDESK_INSTALLED_ENGINE", ROOT / "target" / "debug" / ("broadcast-service" + SUFFIX)))
    if not service_path.is_file():
        raise RuntimeError("Build the service first: cargo build -p broadcast-service")
    ffmpeg, ffprobe = tool("ffmpeg"), tool("ffprobe")
    tool("mediamtx")
    try:
        with socket.create_connection(("127.0.0.1", 9780), timeout=1):
            raise RuntimeError("Port 9780 is in use. Stop your existing engine before running this isolated smoke test.")
    except (ConnectionRefusedError, TimeoutError):
        pass
    with tempfile.TemporaryDirectory(prefix="signaldesk-smoke-") as temporary:
        folder = Path(temporary)
        env = {**os.environ, "BROADCAST_HOME": str(folder / "data")}
        with (folder / "service.log").open("w+") as log:
            service = subprocess.Popen([str(service_path)], env=env, stdout=log, stderr=log)
            try:
                for _ in range(50):
                    if service.poll() is not None:
                        raise RuntimeError("Test engine exited before becoming ready")
                    try:
                        assert api("/api/health")["service"] == "signaldesk"
                        break
                    except (urllib.error.URLError, ConnectionError):
                        time.sleep(0.1)
                else:
                    raise RuntimeError("Test engine did not become ready")
                run_smoke(folder, ffmpeg, ffprobe)
            except BaseException:
                log.flush()
                log.seek(0)
                print(log.read())
                raise
            finally:
                if service.poll() is None:
                    try:
                        api("/api/broadcast/stop", "POST")
                    except Exception:
                        pass
                    if os.name == "nt":
                        service.terminate()
                    else:
                        service.send_signal(signal.SIGINT)
                    try:
                        service.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        service.kill()
                        service.wait()


if __name__ == "__main__":
    main()
