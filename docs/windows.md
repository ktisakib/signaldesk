# Windows installation and operation

## Install on the broadcasting computer

Use Windows 10 version 2004 or newer, or Windows 11 x64. ARM and 32-bit Windows are outside this build's support. Use a Windows version that still receives security updates. FFmpeg's selected Windows build requires Windows 10 or newer; Tauri uses Microsoft's WebView2 runtime. [FFmpeg build requirements](https://www.gyan.dev/ffmpeg/builds/), [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

Install the generated SignalDesk NSIS `.exe`, then open SignalDesk. The installer bundles `runtime/broadcast-service.exe` and the setup scripts. It obtains WebView2 if missing; its default bootstrapper requires internet. It does not bundle FFmpeg or MediaMTX binaries. [Tauri's Windows installer documentation](https://v2.tauri.app/distribute/windows-installer/)

The installer runs the checksum-verified media-tool setup automatically as your current Windows user; internet access is required. If a download fails or you use a source build, copy and run the repair command shown in **Stream setup**. It has this form, with the real installed file path filled in by the app:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\SignalDesk\runtime\setup-windows.ps1"
```

Run it as your normal Windows user. The command bypasses execution policy only for that PowerShell process; it does not alter the machine policy. Organizational policies can still prevent scripts from running. Do not turn off antivirus protection to run the app.

The setup pins FFmpeg 9.0.2 essentials and MediaMTX 1.21.3. It verifies both archives against checked-in SHA-256 hashes and their publishers' checksum manifests over HTTPS. It rejects ambiguous checksums and archive traversal paths, and copies only the expected executables to fixed destinations. Re-running it verifies installed executable hashes and skips unchanged tools. Stop the broadcast before repairing tools that are in use. [Official FFmpeg download providers](https://ffmpeg.org/download.html), [MediaMTX release and checksums](https://github.com/bluenviron/mediamtx/releases/tag/v1.21.3)

Return to SignalDesk and recheck the dependencies. Start the test signal and confirm the preview. Runtime setup does not open internet access; configure that separately with the [network guide](internet-streaming.md).

For the shared Docker relay, channel credentials, drag-and-drop rundown and scheduling workflow, follow the [complete setup guide](setup-guide.md). The laptop makes an outgoing SRT connection and needs no inbound publishing rule.

## When the installer appears stuck on media tools

Version 0.1.1 hides the downloader output while it runs. On that version, open a separate PowerShell window and run the following command twice, a few seconds apart. A growing ZIP means the download is working.

```powershell
Get-ChildItem "$env:TEMP\signaldesk-*\*.zip" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 2 Name, Length, LastWriteTime
```

From v0.1.2 the installer details show the archive name and received MiB every three seconds during a download. A connection attempt times out after 20 seconds, a transfer below 1 KiB/s for 45 seconds fails, and each request has a 15-minute ceiling. Verification and extraction can take additional time. If Setup reports failure, the foreground repair command above displays the error.

For a laptop that cannot download the tools, use another computer to fetch the two original archives and both checksum files listed in [the runtime manifest](../scripts/runtime-downloads.json). Save each archive with its exact `fileName`, and the corresponding checksum file as `<fileName>.sha256`. Copy these four files into one folder on the laptop. Copy `scripts/setup-windows.ps1` from v0.1.2 or later and its matching `runtime-downloads.json` into a folder beside it. After the previous installer and its downloader have exited, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\setup-windows.ps1" -ArchiveDirectory ".\archives"
```

Use the same Windows account for the repair and installation. On success, run the SignalDesk installer again. Versions 0.1.1 and 0.1.2 use the same pinned runtime and recognize the preinstalled tools. WebView2 may still need internet on a fresh Windows installation. Keep your media, profile and database in place.

## Files and background operation

| Location | Purpose |
| --- | --- |
| `%LOCALAPPDATA%\SignalDesk\studio.sqlite` | Library, queue, one-time schedule, and settings |
| `%LOCALAPPDATA%\SignalDesk\runtime\bin` | FFmpeg, FFprobe, and MediaMTX |
| `%LOCALAPPDATA%\SignalDesk\runtime\licenses` | Downloaded tool license/readme files |
| `%LOCALAPPDATA%\SignalDesk\mediamtx.yml` | Generated media-server configuration |
| `%LOCALAPPDATA%\SignalDesk\cache` | Normalized queue clips used for continuous playout |
| `%LOCALAPPDATA%\SignalDesk\relay.json` | Saved relay destination and publishing key; protect profile backups |
| `%LOCALAPPDATA%\SignalDesk\youtube.json` | Optional saved YouTube label and plaintext stream key; protect profile backups |
| `runtime\broadcast-service.exe` beside installed app resources | Independent broadcasting process |

Importing registers the original file's path; keep that file on an available local drive. The application does not upload the library to a cloud server. Back up the SQLite database while the service is stopped and preserve its media files separately. Runtime updates and installer rebuilds do not migrate or erase the library.

Starting a queue first normalizes its clips to the channel's 720p/25 fps H.264/AAC format. Large queues can take substantial preparation time and additional disk space before going live; subsequent starts reuse valid cached files. Keep free disk space available. Cached material can be rebuilt from the originals; do not delete it while the channel is running.

The desktop app starts the service if it is absent. Closing its window leaves the service and queue playout running. Live camera capture needs that window to remain open; closing it ends capture and returns to the saved queue only when the camera's fallback is enabled. **Stop broadcast** stops playout, LAN relay output and YouTube output without queue fallback. Logging out, sleeping, losing power, or restarting Windows interrupts the service. Disable sleep during broadcasting through Windows power settings, and use a UPS if outages matter.

Open **Live production** for **Camera & microphone** and **YouTube channel**. Allow camera and microphone access in the WebView2 prompt and Windows privacy settings before taking the preview on air. If using the Docker edition, capture through a current desktop browser at `http://localhost:8080` instead. YouTube uses a stream key entered only into the local panel; enable the channel's YouTube Live feature first and complete the event's public Go live steps in Live Control Room. YouTube RTMPS needs outbound TCP 443 and no inbound viewer-port rule. See the [live production guide](live-production.md) for the exact workflow, fallback behavior and saved-key handling.

Before upgrading or uninstalling, stop the broadcast and end `broadcast-service.exe` in Task Manager so the independent background process does not lock installed files. Preserve the data directory if you want to keep the library and settings.

## Start after Windows sign-in

Autostart is opt-in. From the installed `runtime` folder, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\set-autostart.ps1
```

For a source build, run the same script from `scripts/`; it uses the release service under `target/release`. You can pass `-ServicePath "C:\full\path\broadcast-service.exe"` explicitly.

This registers a Scheduled Task for the current user at sign-in with limited privileges, no time limit, and up to three restart attempts. It does not store your Windows password or run before sign-in. Keep the executable at its configured path. The saved queue remains available; start playout from the dashboard after startup unless an automatic recovery policy is added to the service. [Scheduled Task settings](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset?view=windowsserver2025-ps)

Remove the task with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\set-autostart.ps1 -Disable
```

Removing the task leaves the current service running.

## Build an installer from source

Development prerequisites are Node.js 24 LTS, stable Rust with the MSVC toolchain, Microsoft's C++ Build Tools **Desktop development with C++**, and WebView2. They are only required on the build computer. [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

```powershell
npm install
npm run build:windows
```

The script runs UI checks, lint, Rust tests, and release builds, then stages the service and scripts as explicitly mapped Tauri resources. It uses NSIS and WebView2's default download bootstrapper. It does not download or redistribute media executables. The installer appears under `target/release/bundle/nsis/`. Code signing is not configured; sign releases before distributing them widely.

Run `setup-windows.ps1 -SelfTest` to exercise checksum matching and archive path validation without network downloads. The Windows workflow also parses every PowerShell script and builds the installer. A successful CI build still needs an installed-app smoke test on a real Windows machine.

For a real streaming smoke test, stop your usual service first so port 9780 is free, install the media runtime, and run:

```powershell
cargo build -p broadcast-service
$env:BROADCAST_BIN_DIR = "$env:LOCALAPPDATA\SignalDesk\runtime\bin"
python scripts/smoke-streaming.py
```

This uses a temporary database and media cache. It generates clips with different codecs, frame rates, and audio layouts, checks the test HLS signal, and fully decodes a looping queue to catch broken transitions. It requires Python 3 and does not change the operator's library.

The Gyan FFmpeg build is GPLv3. The setup downloads it directly from its provider. If you change packaging to redistribute those binaries, preserve license notices and satisfy the corresponding-source obligations for FFmpeg and its included libraries. MediaMTX's release includes its own license. [FFmpeg build licensing](https://www.gyan.dev/ffmpeg/builds/), [MediaMTX license](https://github.com/bluenviron/mediamtx/blob/main/LICENSE)

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing dependency | Run setup as the same Windows user, then recheck Setup. Confirm all three executables exist under the runtime `bin` directory. |
| Desktop cannot connect | Ensure only one `broadcast-service.exe` is running and port `127.0.0.1:9780` is free. Check the app's error text and service logs. |
| Setup cannot replace files | Stop the broadcast. A media process may still be using the executable. |
| Black preview immediately after start | Wait for several HLS segments, then retry. Check the FFmpeg error log if the status changes to error. |
| Imported media no longer plays | Confirm its original absolute file path still exists and the drive is connected. |
| Works locally, fails on another device | Check the Private-network firewall rule, LAN address, router forwarding, and ISP CGNAT. |
| Build fails in the linker | Install the C++ desktop workload and Windows SDK; restart your development terminal. |

For a source build, `scripts/start-service.ps1` redirects startup output to `service.stdout.log` and `service.stderr.log` in the data directory. The live dashboard shows the broadcast log. Do not expose the local control API to troubleshoot public streaming.
