# Windows installation and operation

## Install on the broadcasting computer

Use Windows 10 version 2004 or newer, or Windows 11 x64. ARM and 32-bit Windows are outside this build's support. Use a Windows version that still receives security updates. FFmpeg's selected Windows build requires Windows 10 or newer; Tauri uses Microsoft's WebView2 runtime. [FFmpeg build requirements](https://www.gyan.dev/ffmpeg/builds/), [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

Download the Windows x64 setup file and run it as the user who will broadcast. It includes WebView2, the Rust engine, FFmpeg, FFprobe, MediaMTX and their libraries. After downloading the installer you can install and start a local channel offline. Open **Stream setup**, confirm all three media tools are available, then start the test signal.

If an older setup is waiting on media downloads, close it first. If it cannot exit, save your work and restart Windows before running the new installer. Keep your media and studio database. For an upgrade, stop any active broadcast and exit the app and its background service first.

For channel credentials and scheduling, see the [complete setup guide](setup-guide.md).

## Files and background operation

| Location | Purpose |
| --- | --- |
| `%LOCALAPPDATA%\SignalDesk\studio.sqlite` | Library, queue, one-time schedule, and settings |
| `%LOCALAPPDATA%\SignalDesk\runtime\bin` | FFmpeg, FFprobe, and MediaMTX |
| `%LOCALAPPDATA%\SignalDesk\runtime\licenses` | Tool license notices and matching source archive links |
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

Install Python 3 and MSYS2 on the build PC. In its UCRT64 shell run `pacman -Syu`, then `pacman -S mingw-w64-ucrt-x86_64-ffmpeg mingw-w64-ucrt-x86_64-binutils`. The build script defaults to `C:\msys64` and accepts `-MsysRoot` for a custom location. Other development prerequisites are Node.js 24 LTS, stable Rust with the MSVC toolchain, Microsoft's C++ Build Tools **Desktop development with C++**, and WebView2. They are only required on the build computer. [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

```powershell
npm install
# Release builds need the private updater key provided by the administrator.
$env:TAURI_SIGNING_PRIVATE_KEY = 'C:\private\updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
npm run build:windows
```

The script runs UI checks, lint, Rust tests, and release builds, then stages the service and scripts as explicitly mapped Tauri resources. It stages the signed MSYS2 media libraries, checksum-verified MediaMTX and the offline WebView2 runtime. The installer appears under `target/release/bundle/nsis/`. Code signing is not configured; sign releases before distributing them widely.

Run `setup-windows.ps1 -SelfTest` to exercise checksum matching and archive path validation without network downloads. The Windows workflow also parses every PowerShell script and builds the installer. A successful CI build still needs an installed-app smoke test on a real Windows machine.

For a real streaming smoke test, stop your usual service first so port 9780 is free, install the media runtime, and run:

```powershell
cargo build -p broadcast-service
$env:BROADCAST_BIN_DIR = "$env:LOCALAPPDATA\SignalDesk\runtime\bin"
python scripts/smoke-streaming.py
```

This uses a temporary database and media cache. It generates clips with different codecs, frame rates, and audio layouts, checks the test HLS signal, and fully decodes a looping queue to catch broken transitions. It requires Python 3 and does not change the operator's library.

The release and installed `runtime/licenses/media/MEDIA-SOURCES.txt` list the matching FFmpeg and library source archives with their build recipes. Bundled license notices are in the same directory. [MSYS2 FFmpeg package](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-ffmpeg)

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


The release pipeline keeps updater signing credentials in GitHub Actions secrets. The installed application contains only the public key. The signing key is required to generate updater artifacts from a local release build. Desktop development with `npm run desktop` uses the normal development workflow.

Windows v0.1.3 requires a one-time manual upgrade to v0.1.6 to gain in-app updates. The update installer runs only after the local broadcaster has stopped and its engine has shut down. The release's `latest.json` contains the Windows installer URL and its signature. [Tauri updater reference](https://v2.tauri.app/plugin/updater/)
