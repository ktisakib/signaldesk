# SignalDesk

SignalDesk is a desktop and Docker-based broadcasting studio with a shared IPTV relay. Broadcasters manage their own videos, running order, scheduled starts and live cameras on their laptops. Each laptop sends one encrypted SRT stream to a Docker relay, which distributes independent HLS channels to browsers and IPTV players.

**Deploy from prebuilt releases:** [Windows installer](https://github.com/ktisakib/signaldesk/releases/latest) · [VPS / Windows deployment guide](docs/deployment.md). The configured LAN relay target is `192.168.0.248:18088`, with SRT on UDP `8890`. Images are published to `ghcr.io/ktisakib/signaldesk-relay` and `ghcr.io/ktisakib/signaldesk-studio` after streaming checks pass. Installers automatically download and verify the media tools; laptops can import a private connection profile from the relay administrator.

**Current release: trusted-LAN testing.** Use a reserved private address for the relay, such as `192.168.1.50`. Broadcaster laptops do not need public IPs, domains, inbound router rules or Cloudflare Tunnel. Public internet deployment requires additional HTTPS and network configuration; the supplied relay gateway uses HTTP.

## Project overview

```text
Broadcaster laptop A                    Shared relay computer
┌──────────────────────────┐            Docker Compose
│ Installed desktop app    │            ┌─────────────────────────┐
│ or local Docker web app  │ ── SRT ──→ │ MediaMTX: live channels  │
│                          │            │ Rust: channels and auth  │
│ Local videos + SQLite    │            │ Caddy: web/HLS gateway   │
│ Queue, schedule, cache   │            └────────────┬────────────┘
│ Camera + Rust/FFmpeg     │                         │
└──────────────────────────┘                         ↓ HLS
Broadcaster laptop B ─────────── SRT ──→  /streams/channel-b/index.m3u8
                                         Browser / VLC / IPTV player
```

One relay IP serves multiple channels. Each broadcaster gets a channel ID and publishing key restricted to that channel. Duplicate publishers cannot replace an active broadcaster. The relay does not accept media-library uploads or store original videos, schedules or broadcaster queues. It keeps channel configuration and secrets in SQLite and short live HLS buffers in memory.

### What is implemented

| Area | Features |
| --- | --- |
| Desktop studio | Installable Tauri UI with a separate background Rust engine; native file picker |
| Docker studio | Same browser dashboard and engine, with FFmpeg/FFprobe/MediaMTX included |
| Media library | Local file registration, validated Docker/browser uploads, search and removal of library entries |
| Running order | Drag handles, keyboard sorting, up/down controls, removal, duplicate programs, saved order and relative timeline |
| Scheduling | One pending queue start; create, reschedule, discard edits, cancel, and estimated show start times in the displayed local timezone |
| Live production | Camera/microphone preview, live takeover, mute and optional return to queue |
| Broadcast graphics | Animated lower thirds, editable breaking-news/advertisement banner, continuous ticker, corner logo and live updates; see [graphics guide](docs/broadcast-graphics.md) |
| Relay output | Saved server IP/hostname, publishing port and channel credentials; reachability test and reconnecting encrypted SRT output |
| Shared relay | Channel directory, web player, administrator provisioning, publishing-key rotation and channel removal |
| YouTube | One optional stream-key RTMPS output; event creation/publication remains in YouTube Studio |
| Checks | Type checks, shadcn lint, frontend/Rust tests, real media pipeline tests and Docker relay integration script |

This is one local playout channel per broadcaster engine. Multiple laptops provide multiple relay channels. It is not a recurring per-show calendar, subscription billing system or automatic high-availability broadcast platform.

### Technology

| Component | Implementation |
| --- | --- |
| Dashboard | Astro, React, TypeScript, Tailwind CSS, shadcn Base UI, Zustand |
| Queue sorting | dnd-kit with pointer and keyboard sensors |
| Desktop shell | Tauri v2 |
| Broadcaster / relay control | Rust, Tokio, Axum |
| Local state | SQLite and SQLx |
| Media | FFmpeg, FFprobe, MediaMTX |
| Contribution / viewer transport | Encrypted SRT / HLS (`.m3u8`) |
| Relay gateway | Caddy, Docker Compose |

## Choose the deployment

| Role | Where it runs | Start here |
| --- | --- | --- |
| Shared relay | One fixed LAN computer | `compose.relay.yaml` |
| Installed broadcaster | Each Windows x64 laptop | Install the release `.exe` and import its relay connection profile |
| Browser broadcaster | Docker on a broadcaster's computer | `compose.yaml` |

The relay is not the broadcaster. Running only the relay does not play videos or schedule shows. Run the desktop engine or Docker studio on each broadcaster device as well. Do not use two local engines on overlapping ports.

## 1. Set up the LAN relay

On the relay computer, install Docker Engine with Compose or Docker Desktop using Linux containers. Install Python 3 for the credential generator. Obtain a copy of this project and work from its root directory. Use wired Ethernet and reserve the server's LAN address in your router; examples below use `192.168.1.50`.

On macOS/Linux:

```sh
python3 scripts/setup-relay.py
docker compose --env-file .env.relay -f compose.relay.yaml up --build -d --wait
docker compose --env-file .env.relay -f compose.relay.yaml ps
```

On Windows PowerShell:

```powershell
python scripts/setup-relay.py
docker compose --env-file .env.relay -f compose.relay.yaml up --build -d --wait
docker compose --env-file .env.relay -f compose.relay.yaml ps
```

The generator creates private `.env.relay` credentials and preserves an existing file. Do not commit, share or publish it. Initial builds require internet access and can take several minutes. Node and Rust are built inside Docker; they are not host prerequisites for this deployment.

1. Open `http://localhost:8088/relay/` on the relay machine.
2. Open `.env.relay` in a local text editor and copy `RELAY_ADMIN_TOKEN` into **Relay administration**. The page keeps it in memory; reload or clear it to sign out.
3. Create a channel: ID `news-a`, display name `News A`.
4. Copy its generated publishing key to the intended broadcaster. Keep the administrator token on the server.
5. Create `news-b` with a separate key for another laptop.
6. Permit inbound **TCP 8088** and **UDP 8890** on the relay's trusted LAN interface. Never publish the internal management/authentication ports.
7. From another LAN device, open `http://192.168.1.50:8088/relay/`.

A static private LAN address is sufficient for this test. A domain or public static IP is not required. Guest/client-isolated Wi-Fi can prevent devices from reaching one another. Keep HTTP administration on a trusted LAN.

For exact firewall examples, connection fields and troubleshooting, follow the [complete setup guide](docs/setup-guide.md).

## 2. Install the broadcaster desktop app

### Build the Windows installer

On a **Windows x64 build computer**, install Node.js 24, Rust's stable MSVC toolchain, Microsoft C++ Build Tools with **Desktop development with C++**, the Windows SDK and WebView2. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
npm ci
npm run build:windows
```

The NSIS installer is produced under `target/release/bundle/nsis/`. The [Windows workflow](.github/workflows/windows.yml) builds it on Windows, verifies real HLS playout and publishes the installer plus checksum when a matching `v<version>` tag is pushed. Download builds from [GitHub Releases](https://github.com/ktisakib/signaldesk/releases/latest). FFmpeg, FFprobe and MediaMTX are automatically installed from checksum-verified upstream downloads. Physical laptop and camera endurance tests are still required before an unattended deployment.

### Install on each broadcaster laptop

1. Install the generated `.exe`. End users do not need Node, Rust or C++ Build Tools.
2. The installer automatically downloads pinned, checksum-verified FFmpeg/FFprobe and MediaMTX into the current user's application directory. Internet access is required during installation. Open **Stream setup** to verify all tools are ready; the displayed PowerShell command is available for repair/source builds.
3. Recheck dependencies and confirm that the test signal plays locally.
4. Keep videos on an available local disk. Use **Import media** to register them; importing does not move the original files to the relay.

The installer bundles the Rust engine and setup scripts, but downloads media executables separately. The current installer configuration is unsigned. See [Windows installation, startup and packaging](docs/windows.md) for details.

A macOS development `.app` can be built with `npm run service:build`, staging the engine in `src-tauri/runtime/`, then `npm run tauri -- build --debug --bundles app`. It requires separately installed media tools; an SRT-enabled FFmpeg build is mandatory. This development bundle is not a notarized macOS release.

## 3. Connect a broadcaster to its channel

Open **LAN relay** in the broadcaster app:

| Field | Example |
| --- | --- |
| Relay IP or hostname | `192.168.1.50` |
| SRT publishing port | `8890` |
| Assigned channel ID | `news-a` |
| Publishing key | The key generated for `news-a` |
| Relay web address | `http://192.168.1.50:8088` |

1. **Save connection**.
2. **Test relay connection**. This checks the web address and channel registration; it does not prove that the UDP port or publishing key works.
3. **Enable relay output**. It can wait while local playout is idle.
4. Choose **Go live → Play your queue** or **Send a test signal**. Camera takeover is available in **Live production**.
5. Confirm the channel becomes live on the relay directory and actually plays from another device.

IPTV playback for this example:

```text
http://192.168.1.50:8088/streams/news-a/index.m3u8
```

Use the relay directory's **Watch channel** button for browser playback. A second broadcaster uses `news-b` and its own key. Stop relay output before editing its connection. Rotating a key disconnects its existing publisher; update the laptop before reconnecting.

## 4. Arrange, schedule and reschedule shows

1. Import programs into **Media library**, then use **Queue** to add them.
2. Open **Playout queue**. Drag the grip handle to move a program. For keyboard sorting, focus the handle, press Space/Enter, use arrow keys, and press Space/Enter to drop; Escape cancels. Up/down buttons are also available.
3. Wait for **Running order saved on this computer**. Removing a queue entry leaves the original video and library entry intact. Repeated programs remain separate queue occurrences.
4. Test the full queue once before scheduling. First playback prepares normalized 720p/25 fps material locally; preparation can delay an uncached start.
5. Stop playout and open **Schedule**. Pick a future local date/time, then choose **Schedule queue**. The page displays the computer's timezone and estimated show start times.
6. To change it, choose **Reschedule → Save new time**. **Discard changes** preserves the saved time.
7. **Cancel scheduled start** removes the pending start without deleting the lineup or stopping current playout.

Scheduling starts the current saved queue once. Reordering the queue changes that scheduled lineup. Queue changes and library removal are blocked while a broadcast is running; import can still add new library files. Stop playout before editing the active running order.

Keep the laptop awake and engine running. Enable relay output before the scheduled start. The scheduler does not interrupt an active program; it reports that start as skipped. Starts more than 60 seconds overdue are marked missed. A reboot preserves the queue/schedule but does not automatically resume old playout or re-enable relay output. Camera capture needs its window open; prerecorded playout can continue after the dashboard closes.

## 5. Use the Docker broadcaster web app instead

On a broadcaster computer with Docker:

```sh
docker compose up --build -d --wait
```

Open [the local web studio](http://localhost:8080). Upload a video through **Import media**, or place it in the project's `media` folder and select **Mounted file**, entering `/media/your-video.mp4`. The rest of the queue, scheduling and relay workflow is the same as the desktop edition.

The studio dashboard is bound to loopback; it is not a remotely accessible operator panel. Uploads, SQLite and cache live in the local `studio-data` volume. The `media` folder is mounted read-only. The shared relay does not receive these files.

If the Docker broadcaster and relay run on the **same Docker Desktop computer**, use `host.docker.internal` as the publishing host and `http://host.docker.internal:8088` as the relay web address. Other devices still use the relay machine's LAN IP to watch. Separate laptops should use the relay's LAN IP. Linux may require the host's reachable address or an explicit `host-gateway` mapping.

Stop native playout or give it different local media ports before running Docker on the same computer. See [Docker operation and storage](docs/docker.md).

## Ports and data

| Port | Role | Exposure |
| --- | --- | --- |
| Relay TCP 8088 | Directory, admin UI, HLS | Trusted LAN |
| Relay UDP 8890 | Encrypted SRT publishing | Broadcaster laptops |
| Relay TCP 9790 / 9791 / 9997 | Internal control/auth/MediaMTX API | Docker network only |
| Broadcaster TCP 9780 | Local Rust control API | Loopback; mapped to localhost:8080 in Docker |
| Broadcaster TCP 8554 | Internal local RTSP playout | Local engine only |
| Broadcaster TCP 8888 | Direct local HLS preview | Local/LAN preview; not needed for relay-based viewers |

| Location | Stored data |
| --- | --- |
| Windows `%LOCALAPPDATA%\SignalDesk` | `studio.sqlite`, cache, media tools, `relay.json`, optional `youtube.json` |
| macOS `~/Library/Application Support/SignalDesk` | Equivalent native-engine data |
| Broadcaster Docker `studio-data` | Local database, uploaded files, cache and output credentials |
| Relay Docker `relay-data` | Channel IDs, names and publishing secrets; no media library |
| Relay memory | Short rolling live HLS buffers; recording is disabled |
| `.env.relay` | Private relay admin and callback tokens |

Output keys are saved locally and must be treated as credentials. Back up local databases and original videos separately. Stop services before copying SQLite databases; include journal/WAL files if present. Never use `docker compose down --volumes` as a normal stop/update command because it deletes persistent data.

## Operations and updates

Relay status and recent logs:

```sh
docker compose --env-file .env.relay -f compose.relay.yaml ps
docker compose --env-file .env.relay -f compose.relay.yaml logs --tail 100
```

Stop the relay without deleting channel configuration:

```sh
docker compose --env-file .env.relay -f compose.relay.yaml stop
```

After backing up, update the source and rebuild on the appropriate machine:

```sh
# Relay machine
docker compose --env-file .env.relay -f compose.relay.yaml up --build -d --wait

# Docker broadcaster machine
docker compose up --build -d --wait
```

Plan for interruption during updates. Restart the saved broadcaster queue and enable relay output afterward. Containers restart with Docker, but Docker itself must run after the host boots. Relay channel registration is restored after a media-server restart; enabled broadcaster outputs retry their connection.

The relay consumes upload for every viewer. At 3 Mbps, 10 continuous viewers use approximately 9.72 TB in 30 days before overhead. Local hosting avoids rented VPS transfer charges only when your own connection and ISP terms permit the traffic. A speed-test result is not a sustained capacity guarantee. Default relay reader/memory guardrails are documented in [the LAN guide](docs/lan-relay.md).

## Development and validation

Use Node.js 24 and a stable Rust toolchain. Docker builds pin their own toolchains in `Dockerfile`. Use the lockfiles for repeatable dependency installation:

```sh
npm ci
npm run check
npm run lint
npm test
npm run build
cargo fmt --all -- --check
cargo clippy -p broadcast-service --all-targets -- -D warnings
cargo test -p broadcast-service
```

Desktop development requires platform-specific Tauri prerequisites plus FFmpeg/FFprobe/MediaMTX:

```sh
npm run service:build
npm run desktop
```

Browser development uses two terminals: `npm run service` and `npm run dev`. Open `http://127.0.0.1:4321`; Astro proxies the local API. Avoid an already-running native engine on port 9780 when testing an isolated source build.

With FFmpeg, FFprobe and MediaMTX on `PATH`, explicitly run the normally ignored real-media tests:

```sh
cargo test -p broadcast-service -- --ignored --nocapture --test-threads=1
```

To exercise a running **test** relay and two disposable Docker broadcaster engines:

```sh
docker compose build
python3 scripts/smoke-relay.py
```

The test needs `.env.relay`, the running relay, Docker and host FFmpeg. It generates test media, creates/removes test channels and restarts the relay's MediaMTX container, briefly interrupting other channels. Use a test deployment. It verifies scheduled startup, encrypted publishing, HLS decoding, key isolation, duplicate publisher rejection, key rotation and reconnects.

Windows uses `python` in place of `python3`. For Windows media-tool checks, set `$env:BROADCAST_BIN_DIR = "$env:LOCALAPPDATA\SignalDesk\runtime\bin"` as needed. [CI workflows](.github/workflows) describe automated Windows packaging and Linux Docker checks; workflows must actually run in your repository before their results can be claimed.

## Repository map

```text
src/components/                  Studio, rundown, scheduling, camera and relay UI
src/components/ui/               shadcn Base UI components
src/lib/                         API bridge, local state, queue/time helpers
src/pages/                       Astro studio and relay entry pages
src-tauri/                       Desktop shell and installer configuration
crates/broadcast-service/src/    Local Rust playout, camera, output and scheduler
crates/broadcast-service/src/bin/relay-server.rs  Shared relay control/auth service
docker/                          MediaMTX, gateway and smoke-test configuration
compose.yaml                     Local Docker broadcaster
compose.relay.yaml               Shared LAN relay deployment
scripts/                         Setup, packaging, reviewed-media and smoke helpers
tests/                           Frontend and helper tests
docs/                            Setup, Windows, Docker, networking and rights guides
```

## Verification status and limits

The development workspace has exercised the macOS desktop, ARM64 Docker broadcaster and relay, two-channel HLS playback, scheduling create/reschedule/cancel, pointer and keyboard queue sorting, credential rejection/rotation and media-server restart recovery. Frontend checks and Rust tests have been run locally. GitHub Actions has built and silently installed the Windows NSIS package, verified automatic media-tool installation and decoded real HLS with live graphics changes. A physical Windows laptop, a second physical broadcaster, touch hardware, sustained audience load and public-domain deployment still need environment-specific acceptance testing.

Current limits: one pending queue start per local engine; no recurring EPG calendar, automatic recovery of on-air playout after reboot, adaptive bitrate ladder, subscriber authentication or enforced per-channel bitrate quota. Source changes can briefly reconnect output. Native camera capture stops when its window closes. First-time video preparation needs local disk space and time. A public deployment needs HTTPS, restricted administration, firewall review and a reachable relay address.

## More guides

- [Complete server and broadcaster setup](docs/setup-guide.md)
- [LAN relay configuration and limits](docs/lan-relay.md)
- [Windows installation and startup](docs/windows.md)
- [Docker broadcaster storage and operation](docs/docker.md)
- [Camera and YouTube output](docs/live-production.md)
- [Direct internet access and HTTPS](docs/internet-streaming.md)
- [Optional Cloudflare connector and policy limits](docs/cloudflare-tunnel.md) — not required for this LAN architecture
- [Reviewed media attribution and usage conditions](docs/media-licenses.md)

This workspace contains 20 reviewed complete NASA programs (about 767 MB, 1:09:43), with sources and hashes in `media/playlist.json`. Media files are not embedded in the app or Docker image and may be absent from another copy of the source. Preserve whole-program usage conditions. With the reviewed files present and Python 3.11+, `python scripts/load-playlist.py --start` loads them into the Docker broadcaster; it refuses to replace an active queue.
