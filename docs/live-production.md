# Live camera and YouTube output

Open **Live production** in SignalDesk on the broadcasting computer. **Camera & microphone** selects the local program source. **YouTube channel** sends that program to one YouTube destination using a stream key. The queue, test signal and camera share the same local HLS channel.

## Put the camera on air

1. In **Camera & microphone**, select the camera and microphone, or choose **No microphone · silent audio**. Choose **Enable camera preview** and grant access to the selected devices. Check the preview before broadcasting; preview alone does not change the program on air.
2. Set **Return to shows if the camera disconnects** as required. It needs a nonempty saved queue. When enabled, a disconnected or stalled camera feed returns to that queue automatically.
3. Choose **Take camera on air**. This replaces the current queue or test signal with the camera. Without a microphone track, the engine supplies silent audio.
4. Keep the capture tab or desktop window open, the camera connected, and the computer awake while using the camera. Closing that window, reloading it, or losing capture stops the camera feed.
5. Choose **Return to queue** to leave the camera and restart the saved queue from its first item. The interrupted clip's playback position is not resumed. **Stop broadcast** stops the channel and YouTube output without automatically restarting the queue.

Taking or returning the camera can interrupt the stream for a few seconds while the encoder reconnects. HLS viewers may buffer and the YouTube output may reconnect. This release switches one program source; it does not promise a seamless camera transition. If a queued file disappears before fallback, the dashboard reports an error rather than replacing or deleting the saved library.

With automatic return disabled, ending the camera feed stops the local program and YouTube output. The queue and its files remain saved.

The browser requests access through `getUserMedia`, which needs a secure context and explicit permission. Use [the local Docker studio](http://localhost:8080), the native app, or the localhost development address. An ordinary HTTP page opened through a LAN IP address is not a substitute for localhost camera access. Docker does not need direct USB-camera passthrough because the host browser captures the camera. [Browser capture requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

The app checks the recording formats offered by the current browser. It accepts supported WebM or fragmented MP4 recording and converts the feed to the channel's 720p/25 fps H.264/AAC format. A supported MIME type does not guarantee enough CPU or an available camera; recording can still fail. If the app reports an unsupported recorder, use a current desktop Chrome or Edge browser and test the preview again. [MediaRecorder capability checks](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static)

## Connect a YouTube channel

First verify the channel and enable YouTube Live. The channel must be eligible to stream; YouTube currently requires no live-streaming restrictions during the preceding 90 days and an operator aged at least 16. First-time activation can take up to 24 hours. [Channel eligibility](https://support.google.com/youtube/answer/2474026?hl=en), [first-time activation](https://support.google.com/youtube/answer/2907883?hl=en)

1. Open [YouTube Studio](https://studio.youtube.com), select **Create → Go live**, and create or select the intended encoder stream. Confirm its visibility and other event settings in Live Control Room.
2. Copy that stream's key directly into the masked stream-key field in SignalDesk's **YouTube channel** panel. Enter a channel label and choose **Save channel**. Paste the key only into this local UI, never into chat, screenshots, source files or shared logs.
3. Start a local queue, test signal or live camera, then choose **Start YouTube output**.
4. In Live Control Room, confirm the incoming preview, audio and stream health. A scheduled stream may still need **Go live** unless its auto-start setting is enabled. SignalDesk's **Sending** state describes its encoder connection; it does not verify that the YouTube event is public.
5. To finish, choose **Stop YouTube output** and end the event in Live Control Room as appropriate for its auto-stop setting. Stopping YouTube output leaves the local channel running. Stopping the local broadcast also stops its YouTube output.

This is a stream-key connection. SignalDesk does not sign in to Google, verify ownership, create events, or manage channel settings through OAuth. The label is saved locally. YouTube's [encoder workflow](https://support.google.com/youtube/answer/2907883?hl=en) and [auto-start/auto-stop settings](https://support.google.com/youtube/answer/9854503?hl=en) determine the event's public lifecycle.

SignalDesk sends to `rtmps://a.rtmps.youtube.com:443/live2`. RTMPS encrypts the connection to YouTube and requires outbound TCP 443. You do not need an inbound firewall rule, router forwarding, or a public IP address for this output. Direct public HLS viewing remains a separate setup described in the [internet streaming guide](internet-streaming.md). [Official RTMPS requirements](https://developers.google.com/youtube/data/live/guides/rtmps-ingestion), [YouTube RTMPS setup](https://support.google.com/youtube/answer/10364924?hl=en)

Use sufficient sustained upload bandwidth and monitor Live Control Room. YouTube's current H.264 reference for 720p/30 fps lists 3 Mbps minimum and 8 Mbps recommended; SignalDesk runs at 25 fps and its default 2500 kbps target may need increasing in **Settings**. YouTube recommends a two-second keyframe interval, which the channel encoder uses. Test with motion and microphone audio before the real event. [YouTube encoder guidance](https://support.google.com/youtube/answer/2853702?hl=en)

## Saved credentials and restarts

The stream key is stored as plaintext in `youtube.json` under the service data directory: `/data/youtube.json` in Docker or `%LOCALAPPDATA%\SignalDesk\youtube.json` on Windows. Unix file permissions are restricted to the owner; Windows uses the data directory's access permissions. Data-directory and Docker-volume backups include this file, so keep them private. The API returns only the label, endpoint and configured state; it does not return the saved key.

Stop YouTube output before changing or forgetting its configuration. Leaving the stream-key field blank when saving preserves the current key. **Forget channel** removes the app's saved file; it does not securely erase disk history or remove backups. Reset a leaked key in [YouTube Live Control Room](https://support.google.com/youtube/answer/9854503?hl=en).

Closing a queue-only dashboard leaves its independent channel and YouTube output running. Camera capture depends on its open capture window and the selected queue fallback. After a service, container or computer restart, camera sessions and active output are not resumed: start the local program and YouTube output again explicitly.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Camera or microphone permission is denied | Allow the device in the browser/site permissions and operating-system privacy settings. Close another application that holds the device. |
| Preview works but viewers see the previous program | Preview is local until **Take camera on air** is selected. Allow the HLS buffer to catch up after switching. |
| Returning to the queue fails | Check that the saved queue contains files that still exist and can be read by the service. Fallback restarts that queue from its beginning. |
| YouTube shows connecting, reconnecting or error | Confirm a local program is live, the stream key matches the intended event, outbound TCP 443 is allowed, and YouTube Live is enabled. |
| SignalDesk says Sending but the event is not public | Check the event's visibility, incoming preview, Go live control and auto-start setting in Live Control Room. |
| YouTube health warns about quality | Check sustained upload speed, CPU usage and the configured channel bitrate. Rehearse with the actual camera and movement. |
