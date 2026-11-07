# Broadcast graphics

Open **Broadcast graphics** in the desktop or Docker studio. Enable the elements you want, enter the text and click **Take graphics to air**. Later edits are drafts until you click **Update on-air graphics**. **Hide all graphics** removes the logo/ticker immediately and slides the lower third away.

- Lower third: a title and optional subtitle, with animated entry/exit.
- Ticker: a continuously scrolling message with an editable banner label. Use “BREAKING NEWS”, “LATEST NEWS”, “JOBS”, or your own label. Adjust scrolling speed and accent color.
- Logo: choose a PNG up to 2 MiB and 1024 × 1024 pixels. Transparent PNG works best. Choose the upper-left or upper-right corner and adjust width.

The preview shows the graphics currently applied by the engine. Graphics are composited into the 1280 × 720 program picture, including local HLS, relay and YouTube output. They work with queued videos, the test signal and live camera input. Viewers see live changes after their normal playback buffer. Settings, the logo and the on/off state are saved on this broadcaster and survive engine restarts. No original video files are modified.

English and Bengali Noto fonts are embedded in the Rust engine, under the SIL Open Font License. License files are distributed in `runtime/licenses/fonts` on Windows and `/app/licenses` in the broadcaster Docker image. Rendering/encoding uses the broadcaster's CPU; test sustained performance on the target laptop.

Only overlay content you are allowed to modify. The bundled NASA sample playlist has complete-program-only reuse conditions and must run unchanged, with graphics off.
