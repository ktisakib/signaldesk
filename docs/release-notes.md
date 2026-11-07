Use v0.1.1 or newer on both relay and broadcasters. This release replaces v0.1.0 and keeps the SRT encryption key out of handshake stream-ID metadata.

SignalDesk Windows x64 broadcaster and LAN relay deployment.

- Install the Windows `.exe`; FFmpeg, FFprobe and MediaMTX are downloaded from pinned upstream releases and checksum-verified automatically. Installation needs internet for these tools and, if missing, WebView2.
- Import a private connection profile from the relay administrator, start a local program or queue, and enable relay output. Videos and schedules remain on the laptop.
- Queue drag and drop, scheduled starts, camera takeover, animated broadcast graphics, channel logos and optional YouTube output.
- The Rust engine keeps broadcasting after the dashboard closes. The laptop must remain awake, signed in and connected.
- Relay/studio images are published to GHCR only after the Docker streaming and multi-broadcaster integration checks pass on `main`.

This installer is unsigned. Windows may show a SmartScreen prompt. Windows ARM/32-bit are not supported. HTTP relay administration is intended for a trusted LAN; public deployments require HTTPS, firewall and router configuration. The sample NASA programs must play unchanged, with graphics disabled.

See `docs/deployment.md` and `docs/setup-guide.md` in the repository for installation, channel provisioning, updates and troubleshooting.
