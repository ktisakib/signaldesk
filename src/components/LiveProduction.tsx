import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  Camera,
  CameraOff,
  ExternalLink,
  ListVideo,
  Loader2,
  Mic,
  MicOff,
  Radio,
  Square,
  TvMinimalPlay,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, errorMessage } from "@/lib/api";
import { cameraMimeType, cameraSocketUrl, publishCamera } from "@/lib/camera";
import { useStudio } from "@/lib/store";

interface YouTubeConfig {
  channelName: string;
  configured: boolean;
  serverUrl: string;
}
interface YouTubeStatus {
  state: "idle" | "connecting" | "live" | "reconnecting" | "error";
  channelName: string;
  startedAt: string | null;
  error: string | null;
}

export default function LiveProduction() {
  const { connected, status, queue, settings, refresh } = useStudio();
  const stream = useRef<MediaStream | null>(null);
  const publisher = useRef<{ stop: () => void } | null>(null);
  const previewElement = useRef<HTMLVideoElement>(null);
  const captureVersion = useRef(0);
  const [previewReady, setPreviewReady] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState("default");
  const [microphoneId, setMicrophoneId] = useState("default");
  const [muted, setMuted] = useState(false);
  const [title, setTitle] = useState("Live news");
  const [returnToQueue, setReturnToQueue] = useState(true);
  const cameraActive =
    status?.source === "camera" && ["starting", "live"].includes(status.state);
  const [youtubeConfig, setYoutubeConfig] = useState<YouTubeConfig | null>(
    null,
  );
  const [youtubeStatus, setYoutubeStatus] = useState<YouTubeStatus | null>(
    null,
  );
  const [channelName, setChannelName] = useState("");
  const [streamKey, setStreamKey] = useState("");
  const [youtubeBusy, setYoutubeBusy] = useState(false);
  const [youtubeError, setYoutubeError] = useState("");
  const [youtubeNotice, setYoutubeNotice] = useState("");
  const youtubeActive =
    !!youtubeStatus &&
    ["connecting", "live", "reconnecting"].includes(youtubeStatus.state);

  useEffect(
    () => () => {
      captureVersion.current++;
      publisher.current?.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  useEffect(() => {
    if (status && status.source !== "camera" && publisher.current) {
      publisher.current.stop();
      publisher.current = null;
      setCameraError("");
    }
    if (status?.state === "idle") setCameraError("");
  }, [status?.source, status?.state]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    async function load() {
      try {
        const config = await api<YouTubeConfig>("/api/youtube/config");
        if (!cancelled) {
          setYoutubeConfig(config);
          setChannelName(config.channelName);
        }
      } catch (error) {
        if (!cancelled) setYoutubeError(errorMessage(error));
      }
    }
    async function poll() {
      try {
        const value = await api<YouTubeStatus>("/api/youtube/status");
        if (!cancelled) setYoutubeStatus(value);
      } catch (error) {
        if (!cancelled) setYoutubeError(errorMessage(error));
      }
    }
    void load();
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connected]);

  async function preview(nextCamera = cameraId, nextMicrophone = microphoneId) {
    const version = ++captureVersion.current;
    setCameraBusy(true);
    setCameraError("");
    setPreviewReady(false);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "Camera capture needs Chrome, Edge, Firefox or Safari on localhost, with camera permission.",
        );
      cameraMimeType((type) => MediaRecorder.isTypeSupported(type));
      const capture = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(nextCamera === "default"
            ? {}
            : { deviceId: { exact: nextCamera } }),
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 25, max: 30 },
        },
        audio:
          nextMicrophone === "none"
            ? false
            : {
                ...(nextMicrophone === "default"
                  ? {}
                  : { deviceId: { exact: nextMicrophone } }),
                echoCancellation: true,
                noiseSuppression: true,
              },
      });
      if (version !== captureVersion.current) {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = capture;
      capture.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      capture.getTracks().forEach((track) => {
        track.onended = () => {
          publisher.current?.stop();
          publisher.current = null;
          capture.getTracks().forEach((item) => item.stop());
          stream.current = null;
          setPreviewReady(false);
          setCameraError(
            "The camera or microphone disconnected. Check your saved queue before reconnecting.",
          );
        };
      });
      if (previewElement.current) {
        previewElement.current.srcObject = capture;
        await previewElement.current.play();
      }
      setPreviewReady(true);
      try {
        setDevices(await navigator.mediaDevices.enumerateDevices());
      } catch {
        /* The selected camera can work without device enumeration. */
      }
    } catch (error) {
      if (version === captureVersion.current) {
        stream.current?.getTracks().forEach((track) => track.stop());
        stream.current = null;
        const message =
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "Camera or microphone permission was denied. Allow access in this browser, then enable preview again."
            : errorMessage(error);
        setCameraError(message);
      }
    } finally {
      if (version === captureVersion.current) setCameraBusy(false);
    }
  }

  function closePreview() {
    captureVersion.current++;
    publisher.current?.stop();
    publisher.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (previewElement.current) previewElement.current.srcObject = null;
    setPreviewReady(false);
    setCameraBusy(false);
  }

  async function takeCamera() {
    if (!stream.current) return;
    setCameraBusy(true);
    setCameraError("");
    try {
      const mimeType = cameraMimeType((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const session = await api<{ sessionId: string; webSocketPath: string }>(
        "/api/camera/start",
        "POST",
        {
          title: title.trim(),
          mimeType,
          returnToQueue: returnToQueue && queue.length > 0,
          hasAudio: stream.current.getAudioTracks().length > 0,
        },
      );
      await refresh();
      const origin = isTauri()
        ? "http://127.0.0.1:9780"
        : window.location.origin;
      publisher.current = await publishCamera(
        stream.current,
        mimeType,
        cameraSocketUrl(session.webSocketPath, origin),
        (message) => {
          publisher.current = null;
          setCameraError(message);
          void refresh();
        },
      );
    } catch (error) {
      setCameraError(errorMessage(error));
      void refresh();
    } finally {
      setCameraBusy(false);
    }
  }

  async function returnQueue() {
    setCameraBusy(true);
    setCameraError("");
    try {
      await api("/api/camera/return", "POST", {});
      publisher.current?.stop();
      publisher.current = null;
      setCameraError("");
      await refresh();
    } catch (error) {
      setCameraError(errorMessage(error));
    } finally {
      setCameraBusy(false);
    }
  }

  async function youtubeAction(work: () => Promise<unknown>, notice: string) {
    setYoutubeBusy(true);
    setYoutubeError("");
    setYoutubeNotice("");
    try {
      await work();
      const [config, state] = await Promise.all([
        api<YouTubeConfig>("/api/youtube/config"),
        api<YouTubeStatus>("/api/youtube/status"),
      ]);
      setYoutubeConfig(config);
      setYoutubeStatus(state);
      setChannelName(config.channelName);
      setYoutubeNotice(notice);
    } catch (error) {
      setYoutubeError(errorMessage(error));
    } finally {
      setYoutubeBusy(false);
    }
  }

  function saveChannel(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void youtubeAction(async () => {
      await api("/api/youtube/config", "PUT", {
        channelName: channelName.trim(),
        ...(streamKey.trim() ? { streamKey: streamKey.trim() } : {}),
      });
      setStreamKey("");
    }, "Channel saved on this computer. Start output when your program is ready.");
  }

  const cameraOptions = [
    { value: "default", label: "Default camera" },
    ...devices
      .filter(
        (d) =>
          d.kind === "videoinput" && d.deviceId && d.deviceId !== "default",
      )
      .map((d, i) => ({
        value: d.deviceId,
        label: d.label || `Camera ${i + 1}`,
      })),
  ];
  const micOptions = [
    { value: "default", label: "Default microphone" },
    { value: "none", label: "No microphone · silent audio" },
    ...devices
      .filter(
        (d) =>
          d.kind === "audioinput" && d.deviceId && d.deviceId !== "default",
      )
      .map((d, i) => ({
        value: d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      })),
  ];

  return (
    <div className="live-production">
      <section className="panel camera-panel" aria-labelledby="camera-heading">
        <div className="panel-heading">
          <h2 id="camera-heading">
            <Camera size={16} /> Camera & microphone
          </h2>
          <Badge
            className={
              cameraActive && status?.state === "live"
                ? "on-air-badge"
                : "standby-badge"
            }
          >
            {cameraActive
              ? status?.state === "live"
                ? "ON AIR"
                : "CONNECTING"
              : "PREVIEW"}
          </Badge>
        </div>
        <div className="camera-preview">
          <video
            ref={previewElement}
            autoPlay
            playsInline
            muted
            aria-label="Private camera preview"
            hidden={!previewReady}
          />
          {!previewReady && (
            <div className="camera-slate">
              <Camera size={34} />
              <strong>Your next live story starts here.</strong>
              <p>Preview your camera privately, then take it on air.</p>
            </div>
          )}
          {previewReady && (
            <span className="camera-preview-label">
              {cameraActive ? "CAMERA INPUT" : "PRIVATE PREVIEW"} ·{" "}
              {muted || microphoneId === "none" ? "MIC OFF" : "MIC ON"}
            </span>
          )}
        </div>
        <div className="production-body">
          <div className="production-device-grid">
            <div className="form-field">
              <label htmlFor="camera-device">Camera</label>
              <Select
                items={cameraOptions}
                value={cameraId}
                disabled={cameraBusy || cameraActive}
                onValueChange={(value) => {
                  if (!value) return;
                  setCameraId(value);
                  if (previewReady) void preview(value, microphoneId);
                }}
              >
                <SelectTrigger id="camera-device">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cameraOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="form-field">
              <label htmlFor="microphone-device">Microphone</label>
              <Select
                items={micOptions}
                value={microphoneId}
                disabled={cameraBusy || cameraActive}
                onValueChange={(value) => {
                  if (!value) return;
                  setMicrophoneId(value);
                  if (previewReady) void preview(cameraId, value);
                }}
              >
                <SelectTrigger id="microphone-device">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {micOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="production-actions">
            <Button
              variant="outline"
              disabled={cameraBusy || cameraActive}
              onClick={() => {
                if (previewReady) closePreview();
                else void preview();
              }}
            >
              {cameraBusy ? (
                <Loader2 className="animate-spin" size={15} />
              ) : previewReady ? (
                <CameraOff size={15} />
              ) : (
                <Camera size={15} />
              )}
              {previewReady ? "Close preview" : "Enable camera preview"}
            </Button>
            <Button
              variant="outline"
              disabled={!previewReady || microphoneId === "none"}
              aria-pressed={muted}
              onClick={() => {
                const next = !muted;
                setMuted(next);
                stream.current?.getAudioTracks().forEach((track) => {
                  track.enabled = !next;
                });
              }}
            >
              {muted ? <MicOff size={15} /> : <Mic size={15} />}
              {muted ? "Unmute microphone" : "Mute microphone"}
            </Button>
          </div>
          <div className="form-field">
            <label htmlFor="camera-title">Live program title</label>
            <Input
              id="camera-title"
              value={title}
              maxLength={100}
              disabled={cameraActive}
              onChange={(event) => setTitle(event.target.value)}
            />
            <p>
              Shown in the channel status. Your camera picture stays unchanged.
            </p>
          </div>
          <div className="production-switch">
            <div>
              <label htmlFor="camera-fallback">
                Return to shows if the camera disconnects
              </label>
              <p>
                {queue.length} saved programs · queue restarts from the first
                show.
              </p>
            </div>
            <Switch
              id="camera-fallback"
              checked={returnToQueue}
              onCheckedChange={setReturnToQueue}
              disabled={cameraActive || queue.length === 0}
            />
          </div>
          <div className="production-actions production-air-actions">
            <Button
              className="go-live-button"
              disabled={
                !connected ||
                !previewReady ||
                cameraBusy ||
                cameraActive ||
                !title.trim()
              }
              onClick={() => void takeCamera()}
            >
              <Radio size={15} />
              Take camera on air
            </Button>
            <Button
              variant="outline"
              disabled={
                !connected || !cameraActive || cameraBusy || queue.length === 0
              }
              onClick={() => void returnQueue()}
            >
              <ListVideo size={15} />
              Return to queue
            </Button>
          </div>
          {cameraError && (
            <p className="form-error" role="alert">
              {cameraError}
            </p>
          )}
          <p className="production-note">
            Taking the camera on air replaces the current show. Keep this
            capture window open during live news. Changing pages inside the
            studio keeps the camera running.
          </p>
        </div>
      </section>

      <section
        className="panel youtube-panel"
        aria-labelledby="youtube-heading"
      >
        <div className="panel-heading">
          <h2 id="youtube-heading">
            <TvMinimalPlay size={17} /> YouTube channel
          </h2>
          <Badge
            className={
              youtubeStatus?.state === "live" ? "on-air-badge" : "standby-badge"
            }
          >
            {youtubeStatus?.state === "live"
              ? "SENDING"
              : youtubeStatus?.state === "reconnecting"
                ? "RECONNECTING"
                : youtubeStatus?.state === "connecting"
                  ? "CONNECTING"
                  : "OFFLINE"}
          </Badge>
        </div>
        <div className="production-body">
          <div className="youtube-intro">
            <span className="youtube-emblem">
              <TvMinimalPlay size={27} />
            </span>
            <div>
              <h3>Your channel. A wider audience.</h3>
              <p>
                Send the same live camera or prerecorded lineup to YouTube with
                encrypted RTMPS.
              </p>
            </div>
          </div>
          <form onSubmit={saveChannel}>
            <div className="form-field">
              <label htmlFor="youtube-channel-name">Channel name</label>
              <Input
                id="youtube-channel-name"
                placeholder="My news channel"
                value={channelName}
                maxLength={100}
                required
                disabled={!connected || youtubeBusy || youtubeActive}
                onChange={(event) => setChannelName(event.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="youtube-stream-key">YouTube stream key</label>
              <Input
                id="youtube-stream-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  youtubeConfig?.configured
                    ? "Saved · enter only to replace"
                    : "Paste from YouTube Live Control Room"
                }
                value={streamKey}
                required={!youtubeConfig?.configured}
                disabled={!connected || youtubeBusy || youtubeActive}
                onChange={(event) => setStreamKey(event.target.value)}
              />
              <p>
                {youtubeConfig?.configured
                  ? "A key is saved on this computer. It is never returned to the dashboard."
                  : "Use the key for your chosen channel. Keep it private; enter it here, never in chat."}
              </p>
            </div>
            <div className="production-actions">
              <Button
                variant="outline"
                type="submit"
                disabled={
                  !connected ||
                  youtubeBusy ||
                  youtubeActive ||
                  !channelName.trim()
                }
              >
                {youtubeBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : null}
                Save channel
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={
                  !connected ||
                  youtubeBusy ||
                  youtubeActive ||
                  !youtubeConfig?.configured
                }
                onClick={() =>
                  void youtubeAction(async () => {
                    await api("/api/youtube/config", "DELETE");
                    setStreamKey("");
                  }, "Channel and saved stream key removed.")
                }
              >
                Forget channel
              </Button>
            </div>
          </form>
          <div className="youtube-output-status" aria-live="polite">
            <span
              className={`status-dot ${youtubeStatus?.state === "live" ? "green" : ""}`}
            />
            <div>
              <strong>
                {youtubeStatus?.state === "live"
                  ? `Sending to ${youtubeStatus.channelName}`
                  : youtubeStatus?.state === "reconnecting"
                    ? "Reconnecting YouTube output"
                    : youtubeStatus?.state === "connecting"
                      ? "Connecting to YouTube"
                      : youtubeConfig?.configured
                        ? "Channel ready to connect"
                        : "Connect your YouTube channel"}
              </strong>
              <p>
                {youtubeActive
                  ? "Check the preview and stream health in YouTube Studio. Sending does not confirm public playback."
                  : "Start your local program, then start YouTube output."}
              </p>
            </div>
          </div>
          {!!settings && settings.bitrateKbps < 3000 && (
            <p className="production-note">
              The current video target is{" "}
              {(settings.bitrateKbps / 1000).toFixed(1)} Mbps. YouTube’s 720p
              guidance starts at 3 Mbps; stop local playout and raise the
              bitrate in Settings if stream health reports low quality.
            </p>
          )}
          <div className="production-actions">
            <Button
              className={youtubeActive ? "stop-button" : "go-live-button"}
              disabled={
                !connected ||
                youtubeBusy ||
                (!youtubeActive &&
                  (!youtubeConfig?.configured || status?.state !== "live"))
              }
              onClick={() =>
                void youtubeAction(
                  () =>
                    api(
                      `/api/youtube/${youtubeActive ? "stop" : "start"}`,
                      "POST",
                      {},
                    ),
                  youtubeActive
                    ? "YouTube output stopped. Local playout continues."
                    : "YouTube output started. Check Live Control Room to publish your stream.",
                )
              }
            >
              {youtubeActive ? <Square size={14} /> : <Radio size={15} />}
              {youtubeActive ? "Stop YouTube output" : "Start YouTube output"}
            </Button>
            <a
              href="https://studio.youtube.com/"
              target="_blank"
              rel="noreferrer"
              className="production-external"
            >
              YouTube Studio <ExternalLink size={13} />
            </a>
          </div>
          {(youtubeError || youtubeStatus?.error) && (
            <p className="form-error" role="alert">
              {youtubeError || youtubeStatus?.error}
            </p>
          )}
          {youtubeNotice && (
            <p className="production-success" role="status">
              {youtubeNotice}
            </p>
          )}
          <p className="production-note">
            Enable live streaming in your YouTube channel first. Choose the
            stream’s visibility and title in Live Control Room, then use Go live
            there unless auto-start is enabled. One YouTube destination at a
            time; stop output to switch channels.
          </p>
        </div>
      </section>
    </div>
  );
}
