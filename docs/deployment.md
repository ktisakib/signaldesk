# Deploy SignalDesk on a relay and Windows laptops

The relay receives one encrypted SRT program per laptop and distributes HLS. Source videos, media library, schedule, graphics and encoding stay on each laptop. The relay stores channel credentials and a short rolling HLS buffer in memory, with recording disabled. Every viewer consumes relay upload bandwidth.

Use **v0.1.1 or newer** on both relay and laptops. Older broadcasters are rejected by the corrected authentication protocol. The SRT handshake carries a domain-separated SHA-256 proof; the private publishing key is used separately as the transport encryption passphrase. Keep the high-entropy generated keys.

## Release artifacts

- Source: <https://github.com/ktisakib/signaldesk>
- Windows installer and SHA-256: <https://github.com/ktisakib/signaldesk/releases/latest>
- Relay image: `ghcr.io/ktisakib/signaldesk-relay:stable` (Linux amd64).
- Browser broadcaster image: `ghcr.io/ktisakib/signaldesk-studio:stable` (Linux amd64).

`main` runs frontend, Rust, Docker playout and multi-broadcaster/authentication checks, then publishes the tested images as `stable` and immutable `sha-<full-commit>` tags. A `v<app-version>` tag runs the Windows build, runtime verification and real HLS smoke test, then publishes the installer and checksum to a GitHub release. Secrets, local databases, certificates, downloaded media and connection profiles are excluded from the public repository. Do not run a self-hosted GitHub runner on the relay: it pulls public prebuilt images and needs no GitHub token.

## Relay installation (Ubuntu, Docker Engine and Compose)

The current LAN target is **192.168.0.248**. Reserve that address in the router. The host already uses 8088 and reserves 8090 for CyberPanel; this deployment uses **TCP 18088** for web/HLS and **UDP 8890** for SRT. Keep existing services intact.

```sh
sudo install -d -m 750 /opt/signaldesk
sudo git clone https://github.com/ktisakib/signaldesk.git /opt/signaldesk
cd /opt/signaldesk
sudo python3 scripts/setup-relay.py
sudo chmod 600 .env.relay
sudoedit .env.relay
```

Keep the generated admin and callback tokens. Add/change these non-secret values:

```dotenv
RELAY_IMAGE=ghcr.io/ktisakib/signaldesk-relay:stable
RELAY_BIND_IP=192.168.0.248
RELAY_HTTP_PORT=18088
RELAY_SRT_PORT=8890
```

```sh
sudo ./scripts/deploy-relay.sh
curl --fail http://192.168.0.248:18088/api/health
```

Allow TCP 18088 and UDP 8890 from trusted broadcaster/viewer networks. Do not change the server's existing firewall defaults. Docker's published ports can bypass host firewall input rules; keep the bind IP private and use upstream network rules or `DOCKER-USER` rules when restricting Docker traffic. Internal ports 9790, 9791 and 9997 must not be published.

Open <http://192.168.0.248:18088/relay/>. Obtain `RELAY_ADMIN_TOKEN` from the server's `.env.relay` using a private terminal/editor and paste it into **Relay administration**. Create a channel for each laptop and download its connection profile. Channel profiles contain publishing secrets: distribute them privately. The server administrator token is never given to broadcasters. Creation/rotation returns the publishing key once; rotate it if the original is lost.

## Windows laptop

1. Download the installer and `SHA256SUMS.txt` from the release. Verify with `Get-FileHash .\SignalDesk_0.1.1_x64-setup.exe -Algorithm SHA256` (use the actual release filename).
2. Install on Windows 10 2004+ or Windows 11 x64. The unsigned build may trigger SmartScreen. WebView2 is bootstrapped if missing. No developer tools or Docker are needed.
3. Open SignalDesk → **Relay connection** → **Import a connection profile**, and select the administrator's `.connection.json`. Alternatively enter host `192.168.0.248`, port `8890`, channel ID, publishing key and web address `http://192.168.0.248:18088`.
4. Click **Test relay connection**. This verifies the web address and channel registration; actual publishing verifies the UDP port and key.
5. Start the test signal or import local videos, build the queue, and click **Go live**. Click **Enable relay output**. The relay channel becomes LIVE.
6. Open `http://192.168.0.248:18088/streams/<channel-id>/index.m3u8` in VLC/IPTV, or use **Watch channel** in the relay web page. Each laptop uses a different channel ID/key.
7. Closing the window leaves the Rust engine and active stream running. Keep the laptop awake, plugged in, signed in and network-connected. Camera capture requires its dashboard/window to remain open. Losing a network connection causes enabled relay output to retry.

For sign-in engine autostart, run the installed `runtime/set-autostart.ps1` once from PowerShell with `-ExecutionPolicy Bypass`. This starts the engine after sign-in; it does **not** automatically put a queue on air. Arm a future scheduled start and enable relay output while the engine is running. The system supports one pending queue start, not a recurring calendar. A reboot does not automatically restart an interrupted show. Configure a new start deliberately after an outage.

Before upgrading, stop broadcasting and exit both SignalDesk and its `broadcast-service` process. User data stays under `%LOCALAPPDATA%\SignalDesk`; uninstalling/upgrading must not delete this folder or original videos. Back up both the database and media separately. Media tools and their upstream license notices are installed in `%LOCALAPPDATA%\SignalDesk\runtime`; `setup-windows.ps1` can repair them. The installer downloads the GPL FFmpeg tools directly from their provider instead of repackaging those binaries.

## Browser broadcaster with a prebuilt image

On the broadcaster's own Docker computer, set `image: ghcr.io/ktisakib/signaldesk-studio:stable` in `compose.yaml` instead of `signaldesk:local`, then run:

```sh
docker compose pull
docker compose up --no-build -d --wait
```

Open <http://localhost:8080/> and import the same type of connection profile. Docker on a different laptop can use the server LAN IP directly. Media stays in its local bind mount/data volume, not on the relay.

## Minimal automatic deployment

After the initial deployment is healthy, optionally enable the supplied timer:

```sh
sudo install -m 644 docker/signaldesk-relay-update.service docker/signaldesk-relay-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now signaldesk-relay-update.timer
sudo systemctl list-timers signaldesk-relay-update.timer
```

Every five minutes it pulls verified `stable` images and applies changed images. Unchanged images do not restart containers. Updates can briefly interrupt streams; choose manual deployment instead if you need a maintenance window. Disable updates with `sudo systemctl disable --now signaldesk-relay-update.timer`. Read deployment logs with `sudo journalctl -u signaldesk-relay-update.service -n 80`.

If the relay image fails its health check, the script attempts to restore the previously running relay image. This does not undo configuration files or database migrations. Keep backups and check logs. To pin or roll back deliberately, set `RELAY_IMAGE=ghcr.io/ktisakib/signaldesk-relay:sha-<known-good-full-commit>` in `.env.relay`, then run the script. Preserve `.env.relay` and the named `relay-data` volume. Do not use `down --volumes`. Update the checked-out deployment files manually during a maintenance window; the timer updates images only.

## Acceptance before a public launch

- Two actual laptops publish different channels and both play continuously on a third device.
- Wrong/cross-channel keys and duplicate publishers are refused; rotation revokes an active key.
- The laptop engine continues after closing the UI; test sleep prevention and sign-in recovery on the target hardware.
- Restart the relay containers and verify that enabled outputs reconnect, with channel credentials preserved.
- Measure sustained wired upload, CPU/temperature and concurrent viewers; set a viewer cap appropriate to the link.
- A public domain requires routing to a reachable public address and HTTPS. This private IP is LAN-only. HTTP admin credentials must not be sent over the public internet; no Cloudflare Tunnel is configured.

Signing, target-hardware endurance tests, public routing/domain/TLS and Windows camera permissions require validation in the actual deployment environment.
