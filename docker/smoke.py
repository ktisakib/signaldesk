#!/usr/bin/env python3
"""Exercise a running, idle Docker studio with an empty library; clean up only test files."""

from pathlib import Path
import json
import os
import subprocess
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("SIGNALDESK_SMOKE_URL", "http://localhost:8080")
HLS = os.environ.get("SIGNALDESK_SMOKE_HLS", "http://localhost:8888")
CONTROL_ORIGIN = "http://localhost:8080"
EXEC = (["docker", "exec", os.environ["SIGNALDESK_SMOKE_CONTAINER"]]
        if os.environ.get("SIGNALDESK_SMOKE_CONTAINER")
        else ["docker", "compose", "exec", "-T", "studio"])
STREAM_WARNINGS = ("non-monotonous", "non-monotonic", "backward in time", "segment duration changed")


def container(*args, **options):
    return subprocess.run([*EXEC, *args],
                          cwd=ROOT, check=True, **options)


def api(path, method="GET", body=None):
    request = urllib.request.Request(
        BASE + path, method=method,
        headers={"Content-Type": "application/json", "Origin": CONTROL_ORIGIN, "Host": "localhost:8080"},
        data=json.dumps(body or {}).encode() if method != "GET" else None,
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def assert_clean_logs(status):
    warnings = [line for line in status["logs"]
                if any(pattern in line.lower() for pattern in STREAM_WARNINGS)]
    assert not warnings, "Source stream timing warnings: " + "\n".join(warnings)


def live():
    for _ in range(200):
        status = api("/api/status")
        assert_clean_logs(status)
        if status["state"] == "live":
            return status
        assert status["state"] != "error", status
        time.sleep(0.2)
    raise RuntimeError("Broadcast did not become live in 40 seconds")


def main():
    assert api("/api/status")["state"] == "idle", "Stop the broadcast before this smoke test"
    assert not api("/api/library"), "This isolated smoke test requires an empty library"
    assert not api("/api/queue"), "This isolated smoke test requires an empty queue"
    index_request = urllib.request.Request(BASE, headers={"Host": "localhost:8080"})
    with urllib.request.urlopen(index_request, timeout=5) as response:
        assert "SignalDesk" in response.read().decode()
    diagnostics = api("/api/diagnostics")
    assert diagnostics["webMode"] and diagnostics["platform"] == "linux"
    assert all(diagnostics[name]["available"] for name in ("ffmpeg", "ffprobe", "mediamtx"))
    user = container("id", "-u", capture_output=True, text=True).stdout.strip()
    assert user == "10001", user
    print("PASS: built dashboard, nonroot user, health and all runtime tools", flush=True)

    imported = []
    files = ["/tmp/docker-smoke-short.mp4", "/tmp/docker-smoke-silent.avi"]
    try:
        container("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                  "testsrc2=size=320x240:rate=30:duration=4", "-f", "lavfi", "-i",
                  "sine=frequency=880:duration=2", "-c:v", "libx264", "-c:a", "aac", files[0])
        container("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                  "testsrc2=size=640x360:rate=24:duration=5", "-c:v", "mpeg4", files[1])
        upload = container("curl", "--fail-with-body", "--silent", "-H", "Origin: " + CONTROL_ORIGIN,
                           "-H", "Host: localhost:8080",
                           "-F", "file=@" + files[0], "http://127.0.0.1:9780/api/library/upload",
                           capture_output=True, text=True)
        imported.append(json.loads(upload.stdout))
        files.append(imported[0]["path"])
        imported.append(api("/api/library", "POST", {"path": files[1]}))
        assert imported[0]["hasAudio"] and not imported[1]["hasAudio"]
        assert imported[0]["path"].startswith("/data/uploads/")
        print("PASS: real multipart upload and mounted-path import validate through FFprobe", flush=True)

        api("/api/broadcast/start", "POST", {"source": "test"})
        live()
        with urllib.request.urlopen(HLS + "/live/index.m3u8", timeout=20) as response:
            assert "#EXTM3U" in response.read().decode()
        api("/api/broadcast/stop", "POST")
        api("/api/queue", "PUT", {"ids": [item["id"] for item in imported]})
        api("/api/broadcast/start", "POST", {"source": "queue"})
        live()
        decoder = subprocess.Popen([
            *EXEC, "ffmpeg", "-hide_banner",
            "-loglevel", "warning", "-xerror", "-progress", "pipe:1", "-i",
            "http://127.0.0.1:8888/live/index.m3u8", "-t", "22", "-map", "0:v:0",
            "-map", "0:a:0", "-f", "null", "-",
        ], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            titles = set()
            started = time.monotonic()
            while decoder.poll() is None and time.monotonic() - started < 45:
                status = api("/api/status")
                assert status["state"] == "live", status
                assert_clean_logs(status)
                titles.add(status["currentTitle"])
                time.sleep(0.4)
            stdout, stderr = decoder.communicate(timeout=10)
            assert decoder.returncode == 0, stderr.decode()
            timestamps = [int(line.split("=", 1)[1]) for line in stdout.decode().splitlines()
                          if line.startswith("out_time_us=") and line.split("=", 1)[1].lstrip("-").isdigit()]
            assert timestamps and max(timestamps) >= 21_500_000
            assert len(titles) == 2, titles
            assert_clean_logs(api("/api/status"))
            assert_clean_logs({"logs": stderr.decode().splitlines()})
            print("PASS: test signal and 22 seconds of decoded HLS across mixed/silent queue loops", flush=True)
        finally:
            if decoder.poll() is None:
                decoder.kill()
            decoder.wait()
    finally:
        api("/api/broadcast/stop", "POST")
        api("/api/queue", "PUT", {"ids": []})
        for item in imported:
            api("/api/library/" + str(item["id"]), "DELETE")
        # The library guard above ensures these cache files belong only to this test.
        cache = container("sh", "-c", "test ! -d /data/cache || find /data/cache -maxdepth 1 -type f", capture_output=True, text=True)
        files.extend(cache.stdout.splitlines())
        container("rm", "-f", "--", *files)
    assert api("/api/status")["state"] == "idle"
    assert not api("/api/library") and not api("/api/queue")
    print("PASS: temporary test media removed; container remains healthy and idle", flush=True)


if __name__ == "__main__":
    main()
