SignalDesk 0.1.10 improves desktop live monitoring, media preparation visibility, and Windows installer efficiency.

Key updates in this release:
- **Program Monitor & HLS Playback**: Resolved preview playback in Windows WebView2 using resilient inline HLS transmuxing and autoplay error recovery.
- **Media Preparation Progress**: Live transcoding progress is now parsed and reported in real-time (`Preparing: <title> (<percentage>%)`) when caching media items.
- **Active Preparation State**: The Program Monitor displays an active optimizing slate with live completion status during clip preparation instead of remaining on standby.
- **Lean Windows Installer**: Switched WebView2 packaging to bootstrapper download mode and cleared archive staging, reducing the Windows setup package size from ~350MB+ down to ~85MB.
- **Windows Setup Robustness**: Hardened PowerShell setup scripts and process execution pipelines for reliable native service startup.

Stop broadcasting before installing an update. The single Windows installer includes the desktop application and verified offline media runtime tools (FFmpeg, FFprobe, MediaMTX).
