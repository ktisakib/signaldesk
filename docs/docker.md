# Run SignalDesk with Docker

Docker runs the browser dashboard, Rust engine, FFmpeg, FFprobe and MediaMTX in one Linux container on the same computer. Node and Rust are build tools only; neither runs in the finished container. Docker Desktop on Windows must use Linux containers. The image supports Linux amd64 and arm64 through the base images; Docker builds for the current machine by default.

Start Docker Desktop, then run these commands from the project directory:

```sh
docker compose up --build -d --wait
docker compose ps
```

Open [SignalDesk](http://localhost:8080). The control dashboard is published only on this computer. Browser uploads are saved in the persistent Docker volume. You can also copy files into the project's `media` folder and import their container paths, such as `/media/program.mp4`; the folder is mounted read only.

For the shared LAN server, start with [the complete relay/broadcaster setup guide](setup-guide.md). `compose.relay.yaml` runs the shared relay; this guide describes the separate broadcaster on a laptop. Scheduling and drag-and-drop queue editing are available in this Docker UI.

For a domain through a Dockerized Cloudflare connector, use the optional [Cloudflare Tunnel setup](cloudflare-tunnel.md). It routes viewer traffic to `http://studio:8888` and keeps management local. A real token, domain route and suitable Cloudflare video service are required; ordinary Compose startup does not start a tunnel.

Add videos to the queue, then start the queue broadcast. The first start prepares a uniform 720p, 25 fps copy of each video, which takes time and disk space. Later starts reuse prepared copies. A continuous H.264 encoder keeps program transitions on the same video clock; allow CPU capacity for live encoding as well as preparation. Keep the computer awake and Docker running while the channel is on air. Closing a queue-only browser leaves the channel running.

**Live production** also captures the host browser's camera and microphone, so Docker needs no USB-camera passthrough. Open the studio through `localhost`, grant device access, preview, then choose **Take camera on air**. Keep that capture tab open. **Return to queue** restarts the saved queue from its first item; disconnect fallback runs only when enabled. Follow the [live production guide](live-production.md) for source switching and browser requirements.

The **YouTube channel** panel saves one stream-key destination in `/data/youtube.json` and sends the active program over outbound RTMPS/TCP 443. This output needs no extra Docker port or router forwarding. The saved key is plaintext in the private data volume and is included in volume backups; paste it only into the local panel. Starting the output does not manage the YouTube event's public Go live state. Stop the output before editing or forgetting its configuration.

The included [reviewed playlist](media-licenses.md) contains 20 complete NASA programs. If the downloaded `media/videos` files are present, load them in their saved order and start playout with Python 3.11 or newer:

```sh
python scripts/load-playlist.py --start
```

The helper checks all 20 file hashes before importing and refuses to replace an active broadcast. Python is optional for this bulk-import helper; ordinary browser uploads and broadcasting need only Docker. On another computer, copy this project including its downloaded `media` folder, or download those files again using the documented downloader.

The local viewer stream is [http://localhost:8888/live/index.m3u8](http://localhost:8888/live/index.m3u8). For another device, replace `localhost` with the broadcasting computer's LAN address. Allow inbound TCP 8888 through the computer's firewall. Router port forwarding and a public address are still required for direct internet access; see [internet streaming](internet-streaming.md). Keep the dashboard's port 8080 bound to `127.0.0.1` because the control API has no login.

Keep the HLS port set to 8888 with this Compose file. Changing it inside the dashboard also requires changing the container port mapping. RTSP stays internal and is never published by Compose.

## Stop, restart and update

```sh
docker compose logs --tail=100 studio
docker compose stop
docker compose start --wait
docker compose up --build -d --wait
```

The SQLite library, queue, settings, uploads and prepared video cache live in the `signaldesk_studio-data` volume at `/data`. Stopping or recreating the container preserves that volume. A computer or container restart leaves the saved queue idle; start the broadcast again in the dashboard. Do not use `docker compose down --volumes` unless you intend to erase that stored data. The original files in `media` remain on the host.

The container runs as UID/GID 10001 with a read only root filesystem. A new named volume gets the correct ownership automatically. If you replace `/data` with a Linux host bind mount, make that directory writable by UID 10001 first. Host media must be readable by that user.

## Check the running container

```sh
docker compose exec studio id
docker compose exec studio curl --fail http://127.0.0.1:9780/api/health
docker compose exec studio curl --fail http://127.0.0.1:9780/api/diagnostics
docker compose exec studio ffmpeg -version
docker compose exec studio mediamtx --version
```

The health check verifies the control service, even while no stream is running. An HLS manifest becomes available only after starting playout. If startup fails, check `docker compose logs studio` and verify that host ports 8080 and 8888 are free. Stop the native desktop engine before using Docker playout on the same ports.

Before adding your own videos, you can run the integration smoke test with Python 3:

```sh
python docker/smoke.py
```

It requires an idle container with an empty library and queue. It checks a real browser-style upload, silent video import, test signal, and 22 seconds of decoded HLS across repeated clip transitions. It also rejects source timestamp and HLS segment-duration warnings, even when decoding succeeds. It removes its temporary media and leaves the container idle.

To build both supported architectures for a registry:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t YOUR_REGISTRY/signaldesk:0.1.0 --push .
```

MediaMTX is copied from its [official pinned image](https://mediamtx.org/docs/kickoff/install) and its MIT license is included at `/app/licenses/mediamtx.LICENSE`. FFmpeg comes from Debian's packages; package copyright and licensing notices remain under `/usr/share/doc`. If distributing a modified container image, retain those notices and meet the licenses of the included packages.
