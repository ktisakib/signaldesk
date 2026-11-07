# LAN relay and desktop broadcasters

This deployment is a trusted-LAN test release. It does not require a public IP, domain or Cloudflare. Before public deployment, add HTTPS administration/viewing and restrict administrative access. A public static IP is different from a DHCP reservation on your LAN.

## Server setup

Install Docker Desktop on Windows/macOS, or Docker Engine with Compose on Linux. Use Ethernet and reserve the relay machine's LAN IP in the router. From this project directory:

```sh
python3 scripts/setup-relay.py
docker compose --env-file .env.relay -f compose.relay.yaml up --build -d --wait
```

On Windows use `python` in place of `python3`. The setup creates `.env.relay` without replacing an existing file. Keep this file private. Open `http://SERVER_LAN_IP:8088/relay/`. Paste the `RELAY_ADMIN_TOKEN` from that file into Administration. The token stays in browser memory; clearing it or reloading signs out. Use a trusted network because LAN HTTP does not protect the admin token in transit.

Create a channel such as `news-a`. Copy the generated publishing key once. Give that broadcaster only the channel ID and publishing key, not the administrator token. Create another ID for every independent laptop/channel.

Allow incoming **TCP 8088** (dashboard/HLS) and **UDP 8890** (encrypted publishing) on the server's private-network firewall. Do not publish ports 9790, 9791 or 9997. Client-isolated guest Wi-Fi will not work unless the router explicitly allows access to the relay. To change ports or bind to one interface, set `RELAY_HTTP_PORT`, `RELAY_SRT_PORT`, or `RELAY_BIND_IP` in `.env.relay` and recreate the deployment.

## Broadcaster desktop

Build/install the Windows application using `scripts/build-windows.ps1` on Windows x64 (CI also builds the NSIS installer). The Windows installer includes the media tools. The installed Tauri UI controls a separate local Rust engine; it does not upload your library to the relay.

1. Import files and arrange the playout queue.
2. Open **LAN relay** in the desktop app.
3. Enter server IP, SRT port `8890`, channel ID and publishing key.
4. Set the relay web address to `http://SERVER_LAN_IP:8088`.
5. Save and test the connection. This verifies the web address/channel registration; only live publishing verifies UDP reachability and the key.
6. Enable relay output, then start your queue, test signal or camera. The output can wait for a future scheduled start.
7. Watch the channel from another device using the relay page or VLC:

```text
http://SERVER_LAN_IP:8088/streams/news-a/index.m3u8
```

Each laptop publishes one H.264/AAC stream. The server remuxes it into HLS without re-encoding. Switching camera/queue reconnects output if needed. `live` output status indicates encoder progress; check actual remote playback before announcing a channel. A duplicate publisher is rejected. Rotating/removing a channel revokes the old key and interrupts its live publisher. Stop relay output before saving changed connection settings.

### macOS test build

The local macOS app bundle is built with the same engine. SRT requires an SRT-enabled FFmpeg: Homebrew `ffmpeg-full` includes it, while a minimal `ffmpeg` build may not. Check `ffmpeg -protocols` for an exact `srt` entry. The app reports a clear error if it is missing. On this development machine, `ffmpeg-full` is installed and selected through the app's runtime/bin symlinks. These external Homebrew tools are not embedded in the macOS bundle.

## Scheduling and uptime

The scheduled queue start is **one-shot**, stored in local SQLite, using the date/time zone selected on the laptop. Show offsets follow queue order/durations; this release does not include a recurring daily EPG scheduler. The engine checks once per second. It never interrupts a running broadcast. Starts over 60 seconds overdue are marked missed; failed starts are reported rather than silently retried. Keep the engine running, laptop awake, and enable relay output in advance. The first queue run normalizes media into a local cache before it goes on air. Test the full queue once before scheduling; an uncached queue starts preparing at the scheduled time and can begin playback late. The cache stays on the broadcaster device. Closing the dashboard preserves prerecorded playout. Closing a browser camera capture ends that camera source; use queue fallback. Shutdown/sleep/power failure interrupts the channel. Engine restart preserves the schedule and queue, but does not automatically resume a previously live broadcast or enable relay output.

## Docker broadcaster dashboard

The existing separate `compose.yaml` deployment remains the broadcaster web application:

```sh
docker compose up --build -d --wait
```

Open `http://localhost:8080`, import through the web UI or mount local files in `/media`, then use the same LAN relay form. This Docker deployment belongs on the broadcaster laptop; its `/data` volume and `/media` mount remain on that device. It is not the shared relay. When the relay is on the same Docker Desktop host, use `host.docker.internal` for both the publishing host and relay web address; some Docker Desktop networks cannot loop back through the host's LAN IP. Viewers on other devices should use the server's LAN IP from the relay directory. For separate physical machines, use the relay's LAN IP directly. On Linux, use the host's reachable LAN address or configure the Docker `host-gateway` mapping. Run only one local desktop/Docker playout engine on overlapping ports.

## Data, limits and recovery

- Relay SQLite stores channel IDs, names and publishing secrets only. The file is inside the private `relay-data` Docker volume. Secrets are required to restore SRT encryption configuration; protect backups as credentials.
- No original videos, queue, schedule, upload endpoint, recording or media library exists on the relay. HLS holds seven short segments per active channel in RAM; segments are capped at 8 MB and recordings are disabled. Live media necessarily passes through server memory/network interfaces.
- Default limits: 100 HLS readers per channel; 512 MiB MediaMTX container memory; 256 MiB management container memory. These are guardrails, not verified capacity. HLS reader counts represent sessions, not necessarily unique people. There is no bitrate enforcement in this LAN release; provision only trusted broadcasters.
- Watch with `docker compose --env-file .env.relay -f compose.relay.yaml ps` and `logs --tail 100`. Channel registration is restored after media-server restart; broadcasters reconnect while output remains enabled.
- The gateway has no exposed authentication callback or MediaMTX control API. Viewers are public within the reachable LAN; there is no paid-subscriber access control.
- Back up `.env.relay` and the relay SQLite volume while stopped, including any SQLite journal files. Restore the volume and private environment together. Do **not** run `down --volumes` unless intentionally deleting all registrations.
- Outgoing traffic scales with viewers. This avoids rented transfer fees only if the relay is on your own sufficiently fast, uncapped connection. LAN tests do not prove internet reachability or ISP permission.

## Build verification

`npm test`, `npm run lint`, `npm run build`, `cargo test -p broadcast-service`, and `cargo clippy -p broadcast-service --all-targets -- -D warnings` check the application. `python3 scripts/smoke-relay.py` exercises two isolated Docker broadcaster engines and the running Docker relay, including schedule start, encrypted SRT, HLS decoding, wrong keys, channel isolation, duplicate publishers, revocation and media-server recovery. Build the broadcaster image with `docker compose build` first. It creates temporary test channels and removes them afterward; never run load tests against an occupied production channel.

## Editing the rundown and scheduled start

Use **Playout queue** to drag rows by their grip handles. Pointer/touch sorting, keyboard sorting (Space or Enter to pick up, arrow keys to move, Space or Enter to drop, Escape to cancel), and up/down buttons all save the same running order. Repeated instances of a program remain separate queue entries. A failed save restores the prior order and displays an error. Queue edits and library removal are locked during playout, including at the API boundary; importing new library files is still available.

Use **Schedule** to create a one-time start. **Reschedule** loads the saved local time for editing; **Save new time** replaces it, and **Discard changes** leaves the saved time intact. **Cancel scheduled start** removes the pending start without stopping an active broadcast or changing the queue. The rundown shows estimated dates/times for each show in the computer's displayed timezone. Missed, failed and skipped starts remain visible until cleared or scheduled again. This is still one pending start for the current saved queue, not a recurring calendar or per-program automation system.
