# Complete LAN setup and operator guide

This guide deploys one shared Docker relay and connects installed broadcaster apps or Docker broadcaster dashboards. Start with a trusted local network. Internet domains, public IPs and Cloudflare Tunnel are not needed for the LAN test.

For architecture, features, development and current limitations, see [the README](../README.md).

## 1. Prepare the machines

| Machine | Required software | Responsibility |
| --- | --- | --- |
| Relay server | Docker with Compose; Python 3 for first-time credentials | Receive and distribute channels |
| Windows broadcaster | Installed SignalDesk; its verified media-tool setup | Store media, schedule and encode one channel |
| Docker broadcaster alternative | Docker with Compose | Same local broadcaster through a browser |
| Viewer | Current browser or HLS-compatible player such as VLC | Watch a channel |

Use Ethernet for the relay if possible. Prevent server/laptop sleep while broadcasting. Connect test devices to the same reachable LAN; guest Wi-Fi isolation can block communication. Initial image/tool downloads need internet. Streaming can then stay inside the LAN.

Reserve a fixed relay address through the router's DHCP reservation page. For example:

```text
Relay LAN IP:       192.168.1.50
Relay web port:     8088/TCP
Relay ingest port:  8890/UDP
Broadcaster A ID:   news-a
Broadcaster B ID:   news-b
```

Replace that IP everywhere with the real relay address. Use `ipconfig` on Windows, your OS network settings on macOS, or `ip address` on Linux to find the LAN address. A manually assigned address must belong to the LAN subnet and avoid DHCP conflicts. A public-IP speed-test page does not tell you the server's private address.

## 2. Start the relay

Obtain the project source, open a terminal in its root, start Docker, and check:

```sh
docker version
docker compose version
```

Create the credentials once:

```sh
# macOS/Linux
python3 scripts/setup-relay.py
```

```powershell
# Windows
python scripts/setup-relay.py
```

Then, on any host:

```sh
docker compose --env-file .env.relay -f compose.relay.yaml up --build -d --wait
docker compose --env-file .env.relay -f compose.relay.yaml ps
```

Expect `gateway`, `relay` and `mediamtx` containers to be running; gateway/relay have health checks. The command builds from source. The private `.env.relay` must remain beside the project; the generator refuses to overwrite it.

Optional values in that file:

| Variable | Default | Change when |
| --- | --- | --- |
| `RELAY_HTTP_PORT` | `8088` | Host web port is occupied |
| `RELAY_SRT_PORT` | `8890` | Host publishing port is occupied |
| `RELAY_BIND_IP` | `0.0.0.0` | You want published ports bound to one host interface |
| `RELAY_ADMIN_TOKEN` | Generated | Protect relay administration |
| `RELAY_HOOK_TOKEN` | Generated, different from admin token | Private media-server authentication callback |

Changing host ports does not change the container-internal ports. Recreate containers with the same `up -d --wait` command, then update every affected broadcaster/viewer address. Do not run Compose's expanded configuration in a shared log: it contains environment credentials. `config --quiet` validates without printing them.

## 3. Allow LAN access

Permit inbound TCP 8088 and UDP 8890 on the **relay machine**, restricted to your trusted LAN. Do not open control/authentication ports 9790, 9791 or 9997. Broadcaster laptops do not need inbound rules to publish to the relay.

On a Windows relay, an administrator can add these rules once in elevated PowerShell, using the actual ports if changed:

```powershell
New-NetFirewallRule -Name SignalDeskRelayWeb -DisplayName 'SignalDesk LAN relay web' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8088 -Profile Private -RemoteAddress LocalSubnet
New-NetFirewallRule -Name SignalDeskRelaySrt -DisplayName 'SignalDesk LAN relay SRT' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 8890 -Profile Private -RemoteAddress LocalSubnet
```

Use a Private profile only for a network you trust. If a rule name already exists, inspect/update that rule instead of creating duplicates. Linux Docker-published ports can bypass some host firewall frontends; apply restrictions in the Docker/network firewall path rather than assuming a generic UFW rule covers containers. On macOS, check the host firewall and Docker Desktop network permissions.

Test from a second device:

```text
http://192.168.1.50:8088/api/health
http://192.168.1.50:8088/relay/
```

The health URL should return JSON identifying `signaldesk-relay`. Loading the directory tests HTTP, not SRT/UDP. Use another device when validating LAN access; testing localhost alone is insufficient.

## 4. Create channel credentials

1. On the relay, open `http://localhost:8088/relay/`.
2. Open `.env.relay` in a local editor. On Windows, `notepad .env.relay` is sufficient.
3. Paste only `RELAY_ADMIN_TOKEN` into **Administrator token**.
4. Enter channel ID `news-a` and a display name, then choose **Create channel**.
5. Copy the new publishing key once to Broadcaster A. Treat it as a password.
6. Repeat for `news-b` and Broadcaster B with a separate key.
7. Clear the admin token or reload the page when finished.

Broadcasters need only their channel ID, publishing key, server address and ports. They must not receive the admin/callback tokens. Channel IDs contain 1–64 lowercase letters, digits or hyphens. Each local engine broadcasts one channel at a time.

**Rotate key** disconnects that channel and invalidates its old publishing key. Stop relay output on the laptop, save the replacement key and re-enable it. **Remove channel** revokes registration and closes its live path; the laptop's original videos are unaffected. Viewers do not need the administrator token.

## 5. Install the desktop broadcaster

### Builder: produce the Windows installer

On Windows x64, install Node.js 24, a stable Rust MSVC toolchain, Microsoft C++ Build Tools with Desktop development with C++, the Windows SDK and WebView2. These development tools belong on the build machine, not every broadcaster laptop.

```powershell
npm ci
npm run build:windows
```

Find the generated NSIS `.exe` under `target\release\bundle\nsis\`. The script stages the engine, runtime setup scripts and operator guides into the installer. The Windows GitHub Actions workflow builds and smoke-tests tagged releases and publishes installers with checksums at https://github.com/ktisakib/signaldesk/releases/latest. See [deployment guide](deployment.md).

### Operator: install on the laptop

1. Run the generated installer and open SignalDesk.
2. The installer automatically downloads and verifies the media tools; installation needs internet. Open **Stream setup** to check readiness. If setup failed, retry the actual repair command displayed by the app. Its form is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\actual\installation\runtime\setup-windows.ps1"
```

3. If repairing or using a source build, run that command as the same Windows user who will broadcast. It downloads pinned media-tool archives, verifies checksums and installs the expected executables.
4. Recheck tools in the app. Start a local test signal and confirm preview, then stop it.
5. Import local videos. Keep their original paths/drives available. Source files, SQLite, schedules and normalized cache remain on this laptop.

The setup requires internet for its first downloads. It does not configure the router/firewall or sign-in autostart. Follow [the Windows guide](windows.md) for those optional steps. The executable is unsigned unless the builder configures signing. Test an installed app on Windows before distributing it to clients.

### macOS development test

The development workspace has a `.app` under `target/debug/bundle/macos/SignalDesk.app`. It depends on external FFmpeg/FFprobe/MediaMTX and is not a notarized distribution. FFmpeg must list an exact `srt` entry under `ffmpeg -protocols`; a minimal build can lack it. The tested development machine uses Homebrew `ffmpeg-full`. Do not copy its machine-specific runtime symlinks to another computer.

## 6. Connect and publish

On Broadcaster A, open **LAN relay**:

```text
Relay IP or hostname: 192.168.1.50
SRT publishing port:  8890
Assigned channel ID:  news-a
Publishing key:       <key generated for news-a>
Relay web address:    http://192.168.1.50:8088
```

Choose **Save connection**, then **Test relay connection**. A successful test means the web endpoint is reachable and the ID is registered. To validate the actual SRT key/UDP path:

1. Choose **Enable relay output**.
2. Choose **Go live → Send a test signal**.
3. Check that `news-a` becomes LIVE on the relay directory.
4. Play it from a second device. A sending/live encoder status alone is not enough to prove viewer playback.

Repeat on laptop B with `news-b` and B's key. Publishing into another channel or replacing an existing publisher is rejected. Network interruption triggers retries while relay output remains enabled. Saving a changed connection requires stopping relay output first.

For prerecorded shows, stop the test signal, arrange the queue and start **Go live → Play your queue**. Re-enable relay output if the main Stop button disabled it. The main **Stop broadcast** stops local playout, relay and YouTube outputs; **Stop relay output** leaves local playout running.

## 7. Edit the running order with drag and drop

1. Stop local playout before editing the queue. The UI and API lock queue mutation during a broadcast.
2. In **Media library**, use **Queue** to add a program. Repeated programs are allowed.
3. Open **Playout queue**. Drag a row's grip handle to a new position. Dragging is confined to the handle so normal scrolling and buttons remain usable.
4. For keyboard operation, focus its grip, press Space/Enter, move with arrows, then press Space/Enter to drop. Escape cancels.
5. Alternatively use the up/down buttons. Remove affects only that queue occurrence.
6. Wait for the saved confirmation. The relative timeline, duration offsets and scheduled preview follow the saved running order. Failed saves show an error and roll back the optimistic order.

Library import remains available during playout; removing library records is locked because it can affect the queued lineup. A removed library record never deletes the original file, but it removes queue references to that record.

## 8. Schedule and reschedule

1. Test a new queue once to populate the local normalized cache, then stop it. Preparing uncached media at the scheduled time can delay the actual on-air start.
2. Open **Schedule**. Confirm the displayed timezone is the laptop's intended timezone.
3. Enter a future date and local time. Choose **Schedule queue**.
4. Review the saved date/time and show-by-show estimated start times.
5. Choose **Reschedule** to load the saved time; enter a replacement and choose **Save new time**.
6. **Discard changes** returns to the previous saved time. It does not cancel the schedule.
7. **Cancel scheduled start** removes the pending start. It leaves local media, the queue and any already-running program intact.
8. Enable relay output before the scheduled time and keep the engine running and laptop awake.

There is one pending start for the current saved queue. There is no recurring daily/weekly calendar, and each row is an estimated offset rather than an independently scheduled automation job. Changing the queue changes the pending lineup. An active program is never interrupted: a conflicting start becomes skipped. An engine over 60 seconds late marks the start missed. Failed/skipped/missed state is shown until cleared or scheduled again.

## 9. Watch through HLS

Browser directory:

```text
http://192.168.1.50:8088/relay/
```

Open the channel's **Watch channel** button. In VLC or an IPTV application, open the actual manifest URL:

```text
http://192.168.1.50:8088/streams/news-a/index.m3u8
http://192.168.1.50:8088/streams/news-b/index.m3u8
```

Use the relay address, not the broadcaster's laptop IP. HLS needs several segments before playback begins. Reader/session counts are not guaranteed unique viewer counts. Everyone who can reach an HLS URL can watch; subscriber authentication is not implemented.

## 10. Docker broadcaster alternative

Instead of installing the desktop app on a broadcaster, run this on that broadcaster computer:

```sh
docker compose up --build -d --wait
```

Open `http://localhost:8080`. Import through **Upload a video** or **Mounted file**. Mounted paths refer to the container, for example `/media/program.mp4`, not a Windows `C:\...` path. Source files under the project's `media` directory are mounted read-only; browser uploads are copied to the local persistent volume.

Use the same queue, Schedule, LAN relay and Live production screens. The browser can capture the host laptop's camera/microphone at localhost; Docker does not need direct USB passthrough.

When both relay and broadcaster run in Docker Desktop on the same host:

```text
Relay IP or hostname: host.docker.internal
SRT publishing port:  8890
Relay web address:    http://host.docker.internal:8088
```

A different device still watches using `http://SERVER_LAN_IP:8088/...`. For a relay on a different physical machine, enter its actual LAN IP instead. Linux may require the host's reachable LAN address or `host-gateway` mapping. The standard broadcaster dashboard binds only to `127.0.0.1:8080`; exposing it remotely is not part of this setup.

## 11. Daily operation, restart and upgrades

Before going on air: confirm power/network, dependencies, source-file availability, queue order, completed preparation, clock/timezone, relay credentials, publishing state and actual playback on a separate viewer.

To stop the relay while retaining registration:

```sh
docker compose --env-file .env.relay -f compose.relay.yaml stop
```

To start again:

```sh
docker compose --env-file .env.relay -f compose.relay.yaml up -d --wait
```

For a source update, back up first, replace/update source and rebuild:

```sh
# On the relay
docker compose --env-file .env.relay -f compose.relay.yaml up --build -d --wait

# On a Docker broadcaster
docker compose up --build -d --wait
```

An update/restart interrupts affected channels. After broadcaster restart, explicitly enable relay output and start the saved queue again. A still-pending schedule survives in SQLite, but needs the running engine and enabled relay output. Sign-in autostart starts the Windows engine, not a previously live program or its remote output. Closing the prerecorded dashboard leaves the engine running; closing camera capture ends that source.

## 12. Back up and restore

Back up these separately:

- Relay `.env.relay` and the entire `relay-data` volume. They contain credentials.
- Broadcaster database/data directory or `studio-data` volume, plus original media files. Uploads are inside the Docker studio volume; mounted original videos are outside it.
- Source/configuration needed to rebuild the deployment.

Stop the relevant services before copying SQLite files. Include any journal/WAL files. Keep backups private; keys are stored in the local profile/relay database. Do not delete volumes during an ordinary update.

A simple relay backup from the project directory, after creating a private `backups` folder, is:

```sh
docker compose --env-file .env.relay -f compose.relay.yaml stop
docker compose --env-file .env.relay -f compose.relay.yaml cp relay:/data ./backups/relay-data
docker compose --env-file .env.relay -f compose.relay.yaml up -d --wait
```

Copy `.env.relay` separately into private backup storage. The same stopped-container copy approach can back up `studio:/data` using the broadcaster Compose file. Store each backup under a new dated directory instead of mixing it with an old snapshot.

For recovery, restore the original environment/configuration and the complete data directory into a **fresh named volume**, preserving UID/GID `10001:10001`, before starting the service. Keep the old volume until recovery is verified. Confirm channel registrations, test keys, local library paths and viewer playback. Restoring a broadcaster database without the original media does not restore the videos. Restoring old relay keys may require updating broadcaster credentials.

## Troubleshooting

| Problem | Action |
| --- | --- |
| Relay fails before startup with a missing-token message | Run the credential generator and include `--env-file .env.relay`. Never substitute a publishing key for an admin token. |
| Port already allocated | Stop the conflicting service or change the corresponding host port; recreate containers and update connection fields. |
| Directory works only on server localhost | Check actual LAN IP, bind address, Docker network permission, Private-network firewall and Wi-Fi isolation. |
| Connection test succeeds but publishing fails | Check UDP 8890, correct channel key/ID and SRT-enabled FFmpeg. The HTTP test does not validate UDP. |
| Native output reports missing SRT | Run the verified Windows setup or install an SRT-enabled FFmpeg build; confirm an exact `srt` protocol entry. |
| Docker cannot reach relay on the same computer | Try `host.docker.internal` on Docker Desktop; do not use container localhost for another service. |
| Queue controls are disabled | Stop local playout and wait for connection/save operations. API enforcement also prevents active-queue edits. |
| Time entry does not enable scheduling | Ensure the field is complete, the engine is connected, there are queue items and the schedule has loaded. Invalid/past times produce validation feedback. |
| Scheduled time passed without going live | Inspect status: missed, failed, or skipped-active. Verify awake/running engine, no active program, cache preparation and enabled relay output. |
| Black screen just after starting | Wait for initial HLS segments/preparation; inspect engine log, channel online status and media compatibility. |
| Old publishing key reconnects unsuccessfully | Save the new key after rotation; old keys are intentionally rejected. |
| Camera stops after closing a window | Keep the capture window open or enable queue fallback. |
| Playback stalls with more viewers | Measure sustained upload, CPU/RAM and actual bitrate; lower bitrate or audience load. A local server still sends a stream per viewer. |
| Data seems missing after moving a project | Confirm the original Docker project/volume and native user profile. A new project name creates different named volumes. |

Diagnostics:

```sh
# Relay
docker compose --env-file .env.relay -f compose.relay.yaml ps
docker compose --env-file .env.relay -f compose.relay.yaml logs --tail 100

# Docker broadcaster
docker compose ps
docker compose logs --tail 100
```

Do not include `.env.relay`, publishing keys, YouTube keys or an expanded Compose environment in a public support report.

## Acceptance test before client handoff

- Two independent broadcasters publish to different channel IDs.
- A second physical viewer decodes both `.m3u8` URLs.
- Wrong/cross-channel credentials and duplicate publishers are rejected.
- Queue drag, keyboard sorting, arrows, add/remove and reload preserve the intended order.
- Schedule, reschedule, discard, cancel and timezone preview work as expected.
- Local files and queue remain on their broadcaster; relay recording is off.
- Network interruption and media-server restart reconnect enabled outputs.
- A real Windows installation, camera permission flow, clock behavior, sustained audience load and host restart are verified on the client's actual hardware.

Local automated checks and development-machine tests are documented in the README. They do not replace the last hardware/network acceptance step or establish public-internet capacity.
