import { version } from "../../package.json";
import {
  useEffect,
  useRef,
  useState,
  type SubmitEvent,
  type ReactNode,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import type HlsPlayer from "hls.js";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  Clock3,
  Copy,
  ExternalLink,
  Film,
  FolderOpen,
  Globe2,
  HardDrive,
  LayoutDashboard,
  Layers,
  ListVideo,
  Loader2,
  MonitorPlay,
  MoreHorizontal,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  Signal,
  Square,
  Terminal,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  api,
  errorMessage,
  pickMedia,
  uploadMedia,
  type MediaItem,
  type Settings,
} from "@/lib/api";
import { bytes, duration, viewerCapacity } from "@/lib/format";
import { useStudio } from "@/lib/store";
import LiveProduction from "@/components/LiveProduction";
import RelayConnection from "@/components/RelayConnection";
import Rundown from "@/components/Rundown";
import SchedulePanel from "@/components/SchedulePanel";
import BroadcastGraphics from "@/components/BroadcastGraphics";

type Page =
  | "overview"
  | "library"
  | "queue"
  | "live"
  | "output"
  | "relay"
  | "schedule"
  | "graphics"
  | "settings";
const pages = [
  { id: "relay" as const, name: "LAN relay", icon: Radio },
  { id: "overview" as const, name: "Overview", icon: LayoutDashboard },
  { id: "library" as const, name: "Media library", icon: Clapperboard },
  { id: "queue" as const, name: "Playout queue", icon: ListVideo },
  { id: "schedule" as const, name: "Schedule", icon: Clock3 },
  { id: "live" as const, name: "Live production", icon: Camera },
  { id: "graphics" as const, name: "Broadcast graphics", icon: Layers },
  { id: "output" as const, name: "Stream setup", icon: Radio },
];
const names: Record<Page, string> = {
  relay: "LAN relay",
  schedule: "Schedule",
  graphics: "Broadcast graphics",
  overview: "Overview",
  library: "Media library",
  queue: "Playout queue",
  live: "Live production",
  output: "Stream setup",
  settings: "Channel settings",
};

export default function Studio() {
  const [page, setPage] = useState<Page>("overview");
  const [importOpen, setImportOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const {
    status,
    connected,
    connectionError,
    library,
    queue,
    settings,
    diagnostics,
    refresh,
    poll,
  } = useStudio();
  const live = connected && status?.state === "live";
  const active = status?.state === "live" || status?.state === "starting";

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick(first = false) {
      await (first ? refresh() : poll());
      if (!cancelled)
        timer = setTimeout(() => {
          void tick();
        }, 2000);
    }
    void tick(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh, poll]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(
      () => setNotice(null),
      notice.error ? 12000 : 4500,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);

  const notify = (text: string, error = false) => setNotice({ text, error });
  function openImport() {
    setNotice(null);
    setImportOpen(true);
  }
  function openStart() {
    setNotice(null);
    setStartOpen(true);
  }
  async function action(work: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      await refresh();
      if (success) notify(success);
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify("Copied to clipboard");
    } catch {
      notify(
        "Clipboard unavailable. Select and copy the address directly.",
        true,
      );
    }
  }
  const addToQueue = (item: MediaItem) =>
    action(
      () =>
        api("/api/queue", "PUT", {
          ids: [...queue.map((entry) => entry.id), item.id],
        }),
      `${item.title} added to the queue`,
    );
  const missingTools =
    diagnostics &&
    (!diagnostics.ffmpeg.available ||
      !diagnostics.ffprobe.available ||
      !diagnostics.mediamtx.available);

  return (
    <div className="studio-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a
          className="brand"
          href="#overview"
          onClick={(event) => {
            event.preventDefault();
            setPage("overview");
          }}
          aria-label="SignalDesk home"
        >
          <span className="brand-mark">
            <AudioLines size={22} strokeWidth={2.5} />
          </span>
          <span>
            signaldesk<span className="brand-period">.</span>
          </span>
        </a>
        <div className="workspace-picker">
          <span className="channel-avatar">S</span>
          <div>
            <strong>{settings?.channelName || "My channel"}</strong>
            <span>Local workspace</span>
          </div>
          <MoreHorizontal size={17} aria-hidden="true" />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {pages.map(({ id, name, icon: Icon }) => (
            <button
              key={id}
              aria-label={name}
              title={name}
              className={`nav-item ${page === id ? "selected" : ""}`}
              onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={18} />
              <span>{name}</span>
              {id === "queue" && queue.length > 0 && (
                <span className="nav-count">{queue.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="local-icon">
              <HardDrive size={19} />
            </span>
            <strong>
              Small setup.
              <br />
              Your own signal.
            </strong>
            <p>Your computer runs the channel. No rented server required.</p>
            <button onClick={() => setPage("output")}>
              View setup <ArrowRight size={14} />
            </button>
          </div>
          <button
            aria-label="Settings"
            title="Settings"
            className={`nav-item ${page === "settings" ? "selected" : ""}`}
            onClick={() => setPage("settings")}
          >
            <Settings2 size={18} />
            <span>Settings</span>
          </button>
          <button
            className="nav-item"
            aria-label="Setup guide"
            title="Setup guide"
            onClick={() => setPage("output")}
          >
            <CircleHelp size={18} />
            <span>Setup guide</span>
            <ExternalLink size={13} />
          </button>
          <div className="computer-status">
            <span className={`status-dot ${connected ? "green" : ""}`} />
            <span>
              {connected ? "Local engine connected" : "Local engine offline"}
            </span>
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <strong>{names[page]}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-tag">
              <MonitorPlay size={13} />
              {isTauri()
                ? "Desktop studio"
                : diagnostics?.webMode
                  ? "Web studio"
                  : "Local studio"}
            </span>
            <span className="topbar-divider" />
            <span className="operator-avatar" title="Local operator">
              S
            </span>
          </div>
        </header>
        <main id="main-content" className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR BROADCAST, UNDER CONTROL</div>
              <h1>
                {page === "overview"
                  ? "Your channel starts here."
                  : names[page]}
              </h1>
              <p>
                {page === "overview"
                  ? "One computer. Everything you need to stay on air."
                  : page === "library"
                    ? "Bring your programs together, ready for playout."
                    : page === "queue"
                      ? "Set the running order. Keep your channel moving."
                      : page === "live"
                        ? "Take live news on air, then return to your shows."
                        : page === "output"
                          ? "Take the signal from your computer to your viewers."
                          : page === "schedule"
                            ? "Plan the start. Adjust the time. Keep your lineup in order."
                            : page === "relay"
                              ? "Connect this computer to your shared broadcasting server."
                              : page === "graphics"
                                ? "Put your identity, headlines and announcements on air."
                                : "Make this channel your own."}
              </p>
            </div>
            <div className="heading-actions">
              <Button
                variant="outline"
                onClick={openImport}
                disabled={!connected || busy}
              >
                <Plus size={16} /> Import media
              </Button>
              <Button
                className={active ? "stop-button" : "go-live-button"}
                disabled={!connected || busy}
                onClick={() =>
                  active
                    ? void action(
                        () => api("/api/broadcast/stop", "POST", {}),
                        "Broadcast stopped",
                      )
                    : openStart()
                }
              >
                {busy ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : active ? (
                  <Square size={14} />
                ) : (
                  <Radio size={16} />
                )}
                {active ? "Stop broadcast" : "Go live"}
              </Button>
            </div>
          </div>

          {!connected && (
            <div className="connection-alert" role="status">
              <Terminal size={18} />
              <div>
                <strong>Connect your broadcast engine</strong>
                <p>
                  {connectionError ||
                    "Connecting to the local broadcast service…"}{" "}
                  Run <code>npm run service</code> from the project folder, then
                  reconnect.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} /> Reconnect
              </Button>
            </div>
          )}
          {connected && missingTools && (
            <div className="connection-alert warning">
              <Signal size={18} />
              <div>
                <strong>One last step before going live</strong>
                <p>
                  Install the streaming tools on this computer to enable video
                  playout.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPage("output")}
              >
                Finish setup <ArrowRight size={14} />
              </Button>
            </div>
          )}
          {status?.error && connected && (
            <div className="connection-alert error" role="alert">
              <Activity size={18} />
              <div>
                <strong>The broadcast needs attention</strong>
                <p>{status.error}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLogsOpen(true)}
              >
                View log
              </Button>
            </div>
          )}

          {page === "overview" && (
            <>
              <div className="overview-grid">
                <section className="monitor-section panel">
                  <div className="panel-heading">
                    <h2>
                      <span className={`status-dot ${live ? "green" : ""}`} />
                      Program monitor
                    </h2>
                    <Badge
                      variant="outline"
                      className={live ? "on-air-badge" : "standby-badge"}
                    >
                      {live
                        ? "ON AIR"
                        : status?.state === "starting"
                          ? "STARTING"
                          : "STANDBY"}
                    </Badge>
                  </div>
                  <ProgramMonitor
                    live={live}
                    url={status?.hlsUrl}
                    title={settings?.channelName || "MY CHANNEL"}
                  />
                  <div className="monitor-footer">
                    <div>
                      <span className="status-dot" />
                      <span>
                        {live || status?.state === "starting"
                          ? status?.currentTitle || "Preparing the signal…"
                          : "Ready when you are"}
                      </span>
                    </div>
                    <span className="mono">
                      {live
                        ? `${Math.round(status?.fps || 0)} FPS`
                        : "NO ACTIVE SIGNAL"}
                      <span className="footer-separator">/</span>H.264 · AAC
                    </span>
                  </div>
                </section>
                <section className="channel-panel panel">
                  <div className="panel-heading">
                    <h2>Channel status</h2>
                    <button
                      className="icon-button"
                      aria-label="Open channel settings"
                      onClick={() => setPage("settings")}
                    >
                      <Settings2 size={16} />
                    </button>
                  </div>
                  <div className="channel-state">
                    <span className={`state-symbol ${live ? "is-live" : ""}`}>
                      <Radio size={26} />
                    </span>
                    <h3>
                      {live
                        ? "You’re on air"
                        : status?.state === "starting"
                          ? "Starting the signal"
                          : "Off air. All yours."}
                    </h3>
                    <p>
                      {live
                        ? "Your computer is sending the channel."
                        : "Set your lineup, check your output, and make it live."}
                    </p>
                  </div>
                  <dl className="status-list">
                    <div>
                      <dt>Broadcast engine</dt>
                      <dd>
                        <span
                          className={`status-dot ${connected ? "green" : ""}`}
                        />
                        {connected ? "Connected" : "Offline"}
                      </dd>
                    </div>
                    <div>
                      <dt>Target bitrate</dt>
                      <dd className="mono">
                        {settings
                          ? `${(settings.bitrateKbps / 1000).toFixed(1)} Mbps`
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>Playout mode</dt>
                      <dd>
                        {settings?.loopQueue ? "Continuous loop" : "Play once"}
                      </dd>
                    </div>
                    <div>
                      <dt>Running time</dt>
                      <dd className="mono">
                        <Uptime startedAt={live ? status?.startedAt : null} />
                      </dd>
                    </div>
                  </dl>
                  <button
                    className="text-link status-log-link"
                    onClick={() => setLogsOpen(true)}
                  >
                    <Terminal size={14} /> View engine log{" "}
                    <ArrowRight size={14} />
                  </button>
                </section>
              </div>
              <div className="metric-strip">
                <Metric
                  icon={<ListVideo size={19} />}
                  label="IN THE QUEUE"
                  value={String(queue.length).padStart(2, "0")}
                  detail={`${queue.length === 1 ? "program" : "programs"} ready to play`}
                />
                <Metric
                  icon={<Clock3 size={19} />}
                  label="TOTAL PLAYTIME"
                  value={duration(
                    queue.reduce((sum, item) => sum + item.durationSeconds, 0),
                  )}
                  detail={
                    settings?.loopQueue
                      ? "then starts again"
                      : "plays once, in order"
                  }
                />
                <Metric
                  icon={<HardDrive size={19} />}
                  label="MEDIA LIBRARY"
                  value={String(library.length).padStart(2, "0")}
                  detail={
                    bytes(
                      library.reduce((sum, item) => sum + item.sizeBytes, 0),
                    ) + " on this computer"
                  }
                />
                <Metric
                  icon={<Globe2 size={19} />}
                  label="STREAM OUTPUT"
                  value="HLS"
                  detail="Browser & IPTV compatible"
                />
              </div>
              <div className="lower-grid">
                <section className="panel queue-panel">
                  <div className="panel-heading">
                    <div className="section-title">
                      <h2>Coming up next</h2>
                      <span>Your playout order, at a glance</span>
                    </div>
                    <button
                      className="text-link"
                      onClick={() => setPage("queue")}
                    >
                      Manage queue <ArrowRight size={14} />
                    </button>
                  </div>
                  {queue.length > 0 ? (
                    <QueueRows items={queue.slice(0, 3)} />
                  ) : (
                    <div className="queue-empty">
                      <span className="empty-icon">
                        <ListVideo size={25} />
                      </span>
                      <div>
                        <h3>A little quiet in here.</h3>
                        <p>
                          Add your first program and give your channel a lineup.
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage("library")}
                      >
                        Build your queue <ArrowRight size={14} />
                      </Button>
                    </div>
                  )}
                  <div className="queue-note">
                    <span className="loop-icon">↻</span>
                    {settings?.loopQueue
                      ? "Continuous playout"
                      : "Sequential playout"}
                    <span>·</span>
                    {settings?.loopQueue
                      ? "Your lineup repeats until you stop it."
                      : "Your broadcast stops after the last program."}
                  </div>
                </section>
                <section className="output-card">
                  <div className="output-card-top">
                    <span className="output-icon">
                      <Wifi size={20} />
                    </span>
                    <span className="small-label">BUILT TO BROADCAST</span>
                  </div>
                  <h2>
                    From this desk
                    <br />
                    to their screens.
                  </h2>
                  <p>
                    Serve your live channel straight from this computer. Start
                    local, then open it to the world.
                  </p>
                  <button
                    className="text-link"
                    onClick={() => setPage("output")}
                  >
                    Set up your stream <ArrowRight size={15} />
                  </button>
                  <div className="signal-art" aria-hidden="true">
                    {Array.from({ length: 18 }, (_, index) => (
                      <i
                        key={index}
                        style={{ height: `${15 + ((index * 29) % 64)}px` }}
                      />
                    ))}
                  </div>
                </section>
              </div>
            </>
          )}

          {page === "library" && (
            <MediaLibrary
              items={library}
              busy={busy}
              disabled={!connected || !!active}
              onImport={openImport}
              onAdd={(item) => void addToQueue(item)}
              onDelete={(item) =>
                void action(
                  () => api(`/api/library/${item.id}`, "DELETE"),
                  "Removed from the library. Your original file is unchanged.",
                )
              }
            />
          )}
          {page === "queue" && (
            <section className="panel queue-workspace">
              <div className="panel-heading">
                <div className="section-title">
                  <h2>
                    Channel rundown{" "}
                    <Badge variant="secondary">
                      {queue.length}{" "}
                      {queue.length === 1 ? "program" : "programs"}
                    </Badge>
                  </h2>
                  <span>
                    Starts at 00:00 when you go live ·{" "}
                    {duration(
                      queue.reduce(
                        (sum, item) => sum + item.durationSeconds,
                        0,
                      ),
                    )}{" "}
                    per run
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage("library")}
                >
                  <Plus size={14} /> Add programs
                </Button>
              </div>
              {queue.length ? (
                <>
                  <div
                    className="timeline"
                    aria-label="Relative playout timeline"
                  >
                    {queue.map((item, index) => (
                      <div
                        key={`${item.id}-${index}`}
                        style={{ flex: Math.max(item.durationSeconds, 30) }}
                        title={`${item.title} · ${duration(item.durationSeconds)}`}
                      >
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <strong>{item.title}</strong>
                        <small>{duration(item.durationSeconds)}</small>
                      </div>
                    ))}
                  </div>
                  <Rundown
                    items={queue}
                    disabled={!connected || busy || !!active}
                  />
                </>
              ) : (
                <EmptyState
                  icon={<ListVideo size={28} />}
                  title="Your next program goes here"
                  description="Import a video, then add it from your media library. The saved running order becomes your broadcast."
                  action={
                    <Button onClick={() => setPage("library")}>
                      <Plus size={15} /> Open media library
                    </Button>
                  }
                />
              )}
              <div className="queue-note">
                <Clock3 size={14} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage("schedule")}
                >
                  Schedule this lineup
                </Button>
                Times are relative to broadcast start.{" "}
                {active
                  ? "Stop the broadcast to edit this queue."
                  : "Changes are saved on this computer."}
              </div>
            </section>
          )}
          <div hidden={page !== "live"}>
            <LiveProduction />
          </div>
          {page === "output" && (
            <StreamSetup
              copy={copy}
              onSettings={() => setPage("settings")}
              onTest={openStart}
              connected={connected}
            />
          )}
          {page === "relay" && <RelayConnection />}
          {page === "graphics" && <BroadcastGraphics />}
          {page === "schedule" && (
            <SchedulePanel onQueue={() => setPage("queue")} />
          )}
          {page === "settings" && (
            <ChannelSettings
              settings={settings}
              disabled={!connected || busy || !!active}
              onSave={(next) =>
                void action(
                  () => api("/api/settings", "PUT", next),
                  "Channel settings saved",
                )
              }
            />
          )}
          <footer className="page-footer">
            <span>
              <span className="footer-brand">signaldesk.</span> Independent by
              design.
            </span>
            <span>
              <span className={`status-dot ${connected ? "green" : ""}`} />
              {connected
                ? "All controls stay on this computer"
                : "Waiting for local engine"}
              <span className="footer-separator">·</span>v{version}
            </span>
          </footer>
        </main>
      </div>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="studio-dialog">
          <DialogHeader>
            <DialogTitle>Bring a program on board</DialogTitle>
            <DialogDescription>
              {diagnostics?.webMode
                ? "Upload a video to the broadcast computer, or import a file from its mounted media folder."
                : "Import a video from this computer. Your original file stays where it is."}
            </DialogDescription>
          </DialogHeader>
          {notice?.error && (
            <p className="form-error" role="alert">
              {notice.text}
            </p>
          )}
          <ImportForm
            busy={busy}
            webMode={!!diagnostics?.webMode}
            onUpload={async (file) => {
              await action(async () => {
                await uploadMedia(file);
                setImportOpen(false);
              }, "Video uploaded and added to your media library");
            }}
            onBrowse={async () => {
              try {
                return await pickMedia();
              } catch (error) {
                notify(errorMessage(error), true);
                return null;
              }
            }}
            onImport={async (path) => {
              await action(async () => {
                await api("/api/library", "POST", { path });
                setImportOpen(false);
              }, "Program added to your media library");
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={startOpen} onOpenChange={setStartOpen}>
        <DialogContent className="studio-dialog">
          <DialogHeader>
            <DialogTitle>Let’s put your channel on air</DialogTitle>
            <DialogDescription>
              The broadcast runs on this computer, even when you close the
              dashboard.
            </DialogDescription>
          </DialogHeader>
          {notice?.error && (
            <p className="form-error" role="alert">
              {notice.text}
            </p>
          )}
          <StartForm
            queueLength={queue.length}
            busy={busy}
            missingTools={!!missingTools}
            onStart={(source) =>
              void action(async () => {
                await api("/api/broadcast/start", "POST", { source });
                setStartOpen(false);
              }, "Broadcast is starting. The HLS preview may take a few seconds.")
            }
          />
        </DialogContent>
      </Dialog>
      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="log-dialog">
          <DialogHeader>
            <DialogTitle>Broadcast engine log</DialogTitle>
            <DialogDescription>
              Recent output from your local streaming processes.
            </DialogDescription>
          </DialogHeader>
          <pre className="engine-log">
            {status?.logs.length
              ? status.logs.join("\n")
              : "No process output yet. Start a test signal to check your setup."}
          </pre>
        </DialogContent>
      </Dialog>
      {notice && !importOpen && !startOpen && (
        <div
          className={`toast ${notice.error ? "toast-error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.error ? <Activity size={18} /> : <CheckCircle2 size={18} />}
          <span>{notice.text}</span>
          <button
            className="icon-button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function ProgramMonitor({
  live,
  url,
  title,
}: {
  live: boolean;
  url?: string;
  title: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setPlaybackError(false);
    if (!live || !url || !video.current) return;
    const element = video.current;
    if (element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = url;
      return () => {
        element.removeAttribute("src");
        element.load();
      };
    }
    let cancelled = false;
    let player: HlsPlayer | undefined;
    async function connect() {
      const { default: Hls } = await import("hls.js/light");
      if (cancelled) return;
      if (!Hls.isSupported()) {
        setPlaybackError(true);
        return;
      }
      player = new Hls({ lowLatencyMode: true });
      player.loadSource(url!);
      player.attachMedia(element);
      player.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) setPlaybackError(true);
      });
    }
    void connect().catch(() => {
      if (!cancelled) setPlaybackError(true);
    });
    return () => {
      cancelled = true;
      player?.destroy();
    };
  }, [live, url, retry]);
  return (
    <div className="program-monitor">
      {live ? (
        <>
          <video
            ref={video}
            controls
            autoPlay
            muted
            playsInline
            aria-label="Live channel preview"
            onCanPlay={() => setPlaybackError(false)}
            onError={() => setPlaybackError(true)}
          />
          {playbackError && (
            <div className="preview-waiting">
              <Activity size={25} />
              <strong>Waiting for the HLS signal</strong>
              <span>Check the engine log if the preview does not appear.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRetry((value) => value + 1)}
              >
                <RefreshCw size={14} /> Reconnect preview
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="monitor-grid" />
          <div className="monitor-corner top-left" />
          <div className="monitor-corner top-right" />
          <div className="monitor-corner bottom-left" />
          <div className="monitor-corner bottom-right" />
          <div className="monitor-slate">
            <div className="slate-logo">
              <AudioLines size={37} strokeWidth={1.6} />
            </div>
            <span className="slate-channel">{title}</span>
            <h3>A signal of your own.</h3>
            <p>Your program will appear here when you go live.</p>
            <div className="slate-status">
              <span className="status-dot" /> STANDING BY
            </div>
          </div>
          <div className="monitor-caption">
            <span>PROGRAM / 01</span>
            <span>LOCAL PLAYOUT</span>
          </div>
          <div className="color-strip">
            {[
              "#c5c7be",
              "#d1c371",
              "#7bacaa",
              "#85a687",
              "#b08195",
              "#ac8372",
              "#727aa2",
            ].map((color) => (
              <i key={color} style={{ backgroundColor: color }} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Uptime({ startedAt }: { startedAt?: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      {startedAt ? duration((now - Date.parse(startedAt)) / 1000) : "00:00:00"}
    </>
  );
}

function Metric({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric">
      <span className="metric-icon">{icon}</span>
      <div>
        <span className="small-label">{label}</span>
        <div className="metric-value">{value}</div>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function QueueRows({ items }: { items: MediaItem[] }) {
  return (
    <div className="compact-queue">
      {items.map((item, index) => (
        <div className="compact-queue-row" key={`${item.id}-${index}`}>
          <span className="queue-number mono">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="media-thumb">
            <Film size={19} />
          </span>
          <div>
            <strong>{item.title}</strong>
            <span>
              {item.width} × {item.height} · Video
            </span>
          </div>
          <span className="mono">{duration(item.durationSeconds)}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function MediaLibrary({
  items,
  busy,
  disabled,
  onImport,
  onAdd,
  onDelete,
}: {
  items: MediaItem[];
  busy: boolean;
  disabled: boolean;
  onImport: () => void;
  onAdd: (item: MediaItem) => void;
  onDelete: (item: MediaItem) => void;
}) {
  const [search, setSearch] = useState("");
  const shown = items.filter((item) =>
    item.title.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="panel library-panel">
      <div className="panel-heading">
        <div className="section-title">
          <h2>
            All media <Badge variant="secondary">{items.length}</Badge>
          </h2>
          <span>Local files · originals are never modified</span>
        </div>
        <div className="search-input">
          <Search size={15} />
          <Input
            aria-label="Search media"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a program…"
          />
        </div>
      </div>
      {items.length ? (
        <>
          {shown.length ? (
            <div className="library-table-wrap">
              <table className="media-table">
                <thead>
                  <tr>
                    <th>PROGRAM</th>
                    <th>DURATION</th>
                    <th>FORMAT</th>
                    <th>SIZE</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <div className="rundown-title">
                          <span className="media-thumb">
                            <Film size={20} />
                          </span>
                          <div>
                            <strong>{item.title}</strong>
                            <small title={item.path}>{item.path}</small>
                          </div>
                        </div>
                      </td>
                      <td className="mono">{duration(item.durationSeconds)}</td>
                      <td>
                        {item.width} × {item.height}
                      </td>
                      <td className="muted">{bytes(item.sizeBytes)}</td>
                      <td>
                        <div className="row-actions">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || disabled}
                            onClick={() => onAdd(item)}
                          >
                            <Plus size={14} /> Queue
                          </Button>
                          <button
                            disabled={busy || disabled}
                            className="icon-button"
                            aria-label={`Remove ${item.title} from library`}
                            onClick={() => onDelete(item)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<Search size={24} />}
              title="No matching programs"
              description="Try a different name to find your video."
            />
          )}
        </>
      ) : (
        <EmptyState
          icon={<FolderOpen size={30} />}
          title="Good television starts with a story."
          description="Add your first video to the library. Then build a running order and let your channel play."
          action={
            <Button disabled={busy} onClick={onImport}>
              <Plus size={16} /> Import your first video
            </Button>
          }
        />
      )}
      <div className="queue-note">
        <HardDrive size={14} />
        Files stay on this computer. Keep source files available while
        broadcasting.
      </div>
    </section>
  );
}

function ImportForm({
  busy,
  webMode,
  onBrowse,
  onImport,
  onUpload,
}: {
  busy: boolean;
  webMode: boolean;
  onBrowse: () => Promise<string | null>;
  onImport: (path: string) => Promise<void>;
  onUpload: (file: File) => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"file" | "path">(webMode ? "file" : "path");
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "file" && file) await onUpload(file);
    else if (mode === "path" && path.trim()) await onImport(path.trim());
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="dialog-form">
      {webMode && (
        <div className="import-mode-choices">
          <Button
            type="button"
            variant={mode === "file" ? "default" : "outline"}
            aria-pressed={mode === "file"}
            onClick={() => setMode("file")}
            disabled={busy}
          >
            Upload a video
          </Button>
          <Button
            type="button"
            variant={mode === "path" ? "default" : "outline"}
            aria-pressed={mode === "path"}
            onClick={() => setMode("path")}
            disabled={busy}
          >
            Mounted file
          </Button>
        </div>
      )}
      {mode === "file" ? (
        <>
          <label htmlFor="media-upload">Choose a video</label>
          <Input
            id="media-upload"
            type="file"
            accept="video/*,.mkv,.ts,.m4v"
            required
            disabled={busy}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <p className="form-hint">
            Up to 2 GiB. The video is copied to persistent storage on the
            broadcast computer.
            {file ? ` Selected: ${file.name} · ${bytes(file.size)}` : ""}
          </p>
        </>
      ) : (
        <>
          <label htmlFor="media-path">
            {webMode
              ? "Path inside the container"
              : "Video file on this computer"}
          </label>
          <div className="path-input">
            <Input
              id="media-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={
                webMode ? "/media/my-program.mp4" : "C:\\Videos\\my-program.mp4"
              }
              required
              disabled={busy}
            />
            {isTauri() && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  const selected = await onBrowse();
                  if (selected) setPath(selected);
                }}
              >
                <FolderOpen size={16} /> Browse
              </Button>
            )}
          </div>
          <p className="form-hint">
            {webMode
              ? "Place videos in the project’s media folder, then enter their /media/ path here."
              : "Use an absolute local file path. FFprobe checks the video before adding it."}
          </p>
        </>
      )}
      <div className="import-note">
        <Film size={18} />
        <p>
          Programs are prepared for a consistent stream when you start playout.
          Longer lineups can take time to prepare.
        </p>
      </div>
      <Button
        type="submit"
        disabled={(mode === "file" ? !file : !path.trim()) || busy}
      >
        {busy ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <ArrowDownToLine size={16} />
        )}
        {busy
          ? mode === "file"
            ? "Uploading & checking…"
            : "Checking video…"
          : "Add to media library"}
      </Button>
    </form>
  );
}

function StartForm({
  queueLength,
  busy,
  missingTools,
  onStart,
}: {
  queueLength: number;
  busy: boolean;
  missingTools: boolean;
  onStart: (source: "test" | "queue") => void;
}) {
  const [source, setSource] = useState<"test" | "queue">(
    queueLength ? "queue" : "test",
  );
  return (
    <div className="dialog-form">
      <div className="source-choices">
        <button
          className={
            source === "queue" ? "source-choice chosen" : "source-choice"
          }
          onClick={() => setSource("queue")}
          disabled={!queueLength || busy}
        >
          <ListVideo size={22} />
          <strong>Play your queue</strong>
          <span>
            {queueLength} {queueLength === 1 ? "program" : "programs"} in the
            saved running order
          </span>
          {source === "queue" && <CheckCircle2 size={16} />}
        </button>
        <button
          className={
            source === "test" ? "source-choice chosen" : "source-choice"
          }
          onClick={() => setSource("test")}
          disabled={busy}
        >
          <MonitorPlay size={22} />
          <strong>Send a test signal</strong>
          <span>Color bars and a quiet test tone</span>
          {source === "test" && <CheckCircle2 size={16} />}
        </button>
      </div>
      {missingTools && (
        <p className="form-error">
          Install FFmpeg and MediaMTX in Stream setup before starting.
        </p>
      )}
      <p className="form-hint">
        Keep this computer awake and connected. Viewers use your internet upload
        bandwidth.
      </p>
      <Button
        disabled={busy || missingTools || (source === "queue" && !queueLength)}
        onClick={() => onStart(source)}
      >
        {busy ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Radio size={16} />
        )}
        Start broadcast
      </Button>
    </div>
  );
}

function StreamSetup({
  copy,
  onSettings,
  onTest,
  connected,
}: {
  copy: (value: string) => Promise<void>;
  onSettings: () => void;
  onTest: () => void;
  connected: boolean;
}) {
  const { settings, diagnostics, status, refresh } = useStudio();
  const [upload, setUpload] = useState(20);
  const toolsReady =
    !!diagnostics &&
    diagnostics.ffmpeg.available &&
    diagnostics.ffprobe.available &&
    diagnostics.mediamtx.available;
  const localUrl = status?.hlsUrl || "http://localhost:8888/live/index.m3u8";
  const publicUrl = status?.publicUrl || "";
  return (
    <div className="setup-grid">
      <div>
        <section className="panel">
          <div className="panel-heading">
            <div className="section-title">
              <h2>A short path to your first signal</h2>
              <span>Everything runs on this computer</span>
            </div>
            <Signal size={19} />
          </div>
          <div className="setup-steps">
            <div className="setup-step">
              <span className="step-number">01</span>
              <div>
                <h3>
                  {toolsReady
                    ? "Your streaming runtime is ready"
                    : "Install the streaming tools"}
                </h3>
                <p>
                  {diagnostics?.webMode
                    ? "Docker includes FFmpeg, FFprobe, and MediaMTX. Your library, uploads, and prepared videos stay in the persistent data volume. To start the app from its project folder:"
                    : toolsReady
                      ? "FFmpeg, FFprobe and MediaMTX are available. Open Relay connection to import the profile supplied by your administrator, then start a local test signal."
                      : "The Windows installer includes all three media tools. Run the installer again to replace missing files. For a source build, use the command below."}
                </p>
                {(!toolsReady || diagnostics?.webMode) && (
                  <CodeCopy
                    value={
                      diagnostics?.webMode
                        ? "docker compose up -d --build"
                        : isTauri() && diagnostics?.setupScript
                          ? `powershell -NoProfile -ExecutionPolicy Bypass -File '${diagnostics.setupScript.replaceAll("'", "''")}'`
                          : "npm run setup:windows"
                    }
                    copy={copy}
                  />
                )}
                <div className="tool-checks">
                  {(["ffmpeg", "ffprobe", "mediamtx"] as const).map((tool) => (
                    <span
                      key={tool}
                      className={
                        diagnostics?.[tool].available ? "tool-ready" : ""
                      }
                    >
                      {diagnostics?.[tool].available ? (
                        <CheckCircle2 size={13} />
                      ) : (
                        <span className="status-dot" />
                      )}
                      {tool === "mediamtx"
                        ? "MediaMTX"
                        : tool === "ffprobe"
                          ? "FFprobe"
                          : "FFmpeg"}
                    </span>
                  ))}
                  <button className="text-link" onClick={() => void refresh()}>
                    <RefreshCw size={12} /> Recheck
                  </button>
                </div>
                <p className="form-hint">
                  {diagnostics?.webMode
                    ? "Add existing files to the mounted media folder, or upload videos through Import media. Controls are available only on the Docker host."
                    : toolsReady
                      ? "Your engine keeps broadcasting when you close the dashboard. Keep this laptop awake and connected to the network."
                      : "See the Windows guide in the installation’s runtime/docs folder for repair instructions."}
                </p>
              </div>
            </div>
            <div className="setup-step">
              <span className="step-number">02</span>
              <div>
                <h3>Check the signal locally</h3>
                <p>
                  Start a test signal, then open your local viewer page. Another
                  device on your network can use this computer’s LAN IP instead
                  of localhost.
                </p>
                <CodeCopy value={localUrl} copy={copy} />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    !connected ||
                    status?.state === "live" ||
                    status?.state === "starting"
                  }
                  onClick={onTest}
                >
                  <MonitorPlay size={14} /> Start a test signal
                </Button>
              </div>
            </div>
            <div className="setup-step">
              <span className="step-number">03</span>
              <div>
                <h3>Direct viewer access</h3>
                <p>
                  {diagnostics?.webMode
                    ? "Docker publishes the HLS viewer on TCP 8888. Allow that port in this computer’s firewall, then forward it from the router to this computer. Keep management port 8080 private."
                    : "Allow inbound TCP 8888 in Windows Firewall, then forward that port from your router to this computer."}{" "}
                  Set your public viewer address in channel settings.
                </p>
                <button className="text-link" onClick={onSettings}>
                  Set public address <ArrowRight size={14} />
                </button>
                <div className="network-note">
                  <Globe2 size={17} />
                  <p>
                    Direct access needs a public IPv4 address or reachable IPv6.
                    If your ISP uses CGNAT, ask them for a public address. Port
                    forwarding alone cannot bypass it.
                  </p>
                </div>
              </div>
            </div>
            {diagnostics?.webMode && (
              <div className="setup-step">
                <span className="step-number">04</span>
                <div>
                  <h3>Or connect your domain with Cloudflare Tunnel</h3>
                  <p>
                    Create a remotely managed Cloudflared tunnel in Cloudflare.
                    Copy .env.example to .env in this project and enter its
                    token privately as CLOUDFLARE_TUNNEL_TOKEN. Add your public
                    hostname with HTTP service <code>studio:8888</code>, then
                    start the connector:
                  </p>
                  <CodeCopy
                    value="docker compose -f compose.yaml -f compose.cloudflare.yaml up -d --wait"
                    copy={copy}
                  />
                  <p>
                    Use <code>https://your-domain/live/</code> for the player.
                    Set the public viewer address to{" "}
                    <code>https://your-domain</code>. The tunnel needs no
                    inbound router forwarding; keep operator port 8080 private.
                  </p>
                  <p className="form-hint">
                    Cloudflare requires a suitable paid service for public video
                    on standard plans. This is not unlimited free IPTV hosting.{" "}
                    <a
                      className="text-link"
                      href="https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/#large-file-and-streaming-traffic-through-tunnel"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Read Cloudflare’s video limitation{" "}
                      <ExternalLink size={12} />
                    </a>
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>
        <section className="panel viewer-panel">
          <div className="panel-heading">
            <h2>Your viewer link</h2>
            <Badge variant="outline">HLS</Badge>
          </div>
          <div className="viewer-link-body">
            <p>
              Paste this into an IPTV player or a website player that supports
              HLS.
            </p>
            {publicUrl ? (
              <CodeCopy value={publicUrl} copy={copy} />
            ) : (
              <div className="unset-address">
                <Globe2 size={18} />
                <span>
                  Add your public viewer address in Settings to create the
                  internet viewer link.
                </span>
                <Button variant="outline" size="sm" onClick={onSettings}>
                  Settings <ArrowRight size={13} />
                </Button>
              </div>
            )}
            <p className="form-hint">
              For browser viewing, open the same URL without{" "}
              <code>index.m3u8</code>. For an HTTPS website, serve the channel
              over HTTPS through a reverse proxy or the configured Cloudflare
              Tunnel.
            </p>
          </div>
        </section>
      </div>
      <div>
        <section className="capacity-panel">
          <span className="output-icon">
            <Wifi size={22} />
          </span>
          <h2>Know your bandwidth.</h2>
          <p>Every viewer uses a separate share of your upload connection.</p>
          <label htmlFor="upload-speed">Available upload speed</label>
          <div className="upload-input">
            <Input
              id="upload-speed"
              type="number"
              min="1"
              max="10000"
              value={upload}
              onChange={(event) => setUpload(Number(event.target.value))}
            />
            <span>Mbps</span>
          </div>
          <div className="capacity-result">
            <strong>
              ~{viewerCapacity(upload, settings?.bitrateKbps || 4000)}
            </strong>
            <span>simultaneous viewers</span>
          </div>
          <p className="form-hint">
            Estimate at {((settings?.bitrateKbps || 4000) / 1000).toFixed(1)}{" "}
            Mbps video + 128 Kbps audio, with 30% upload headroom and 10%
            transport allowance. Actual capacity depends on your computer and
            connection.
          </p>
        </section>
        <section className="setup-safety">
          <HardDrive size={19} />
          <h3>Your computer is the station.</h3>
          <ul>
            <li>Keep it powered on and prevent sleep.</li>
            <li>Prefer wired Ethernet for steady upload.</li>
            <li>Only expose the HLS viewer port.</li>
            <li>Control and publishing stay local.</li>
          </ul>
          <p>
            There is no built-in viewer authentication. Treat a public stream as
            publicly accessible.
          </p>
        </section>
      </div>
    </div>
  );
}

function CodeCopy({
  value,
  copy,
}: {
  value: string;
  copy: (value: string) => Promise<void>;
}) {
  return (
    <div className="code-copy">
      <code>{value}</code>
      <button
        className="icon-button"
        aria-label={`Copy ${value}`}
        onClick={() => void copy(value)}
      >
        <Copy size={15} />
      </button>
    </div>
  );
}

function ChannelSettings({
  settings,
  disabled,
  onSave,
}: {
  settings: Settings | null;
  disabled: boolean;
  onSave: (settings: Settings) => void;
}) {
  if (!settings)
    return (
      <section className="panel">
        <EmptyState
          icon={<Settings2 size={27} />}
          title="Waiting for your local engine"
          description="Connect the broadcast service to load your saved channel settings."
        />
      </section>
    );
  return (
    <SettingsForm
      key={JSON.stringify(settings)}
      settings={settings}
      disabled={disabled}
      onSave={onSave}
    />
  );
}

function SettingsForm({
  settings,
  disabled,
  onSave,
}: {
  settings: Settings;
  disabled: boolean;
  onSave: (settings: Settings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(draft);
  }
  return (
    <form className="panel settings-panel" onSubmit={submit}>
      <div className="panel-heading">
        <div className="section-title">
          <h2>Channel identity & output</h2>
          <span>Saved to your local database</span>
        </div>
        <Settings2 size={19} />
      </div>
      <div className="settings-body">
        <div className="form-field">
          <label htmlFor="channel-name">Channel name</label>
          <Input
            id="channel-name"
            value={draft.channelName}
            maxLength={80}
            required
            disabled={disabled}
            onChange={(event) =>
              setDraft({ ...draft, channelName: event.target.value })
            }
          />
          <p>The name you see throughout the studio.</p>
        </div>
        <div className="settings-row">
          <div className="form-field">
            <label htmlFor="bitrate">Video bitrate · Kbps</label>
            <Input
              id="bitrate"
              type="number"
              min="500"
              max="20000"
              step="100"
              value={draft.bitrateKbps}
              required
              disabled={disabled}
              onChange={(event) =>
                setDraft({ ...draft, bitrateKbps: Number(event.target.value) })
              }
            />
            <p>A lower bitrate leaves room for more viewers.</p>
          </div>
          <div className="form-field">
            <label htmlFor="public-host">Public viewer address</label>
            <Input
              id="public-host"
              value={draft.publicHost}
              placeholder="https://tv.example.com"
              disabled={disabled}
              onChange={(event) =>
                setDraft({ ...draft, publicHost: event.target.value })
              }
            />
            <p>
              For Cloudflare Tunnel, use https://tv.example.com without a path
              or port. For direct HLS, enter a hostname or IP only.
            </p>
          </div>
        </div>
        <div className="settings-switch">
          <div>
            <label htmlFor="loop-queue">Loop the playout queue</label>
            <p>Start from the first program after the last one ends.</p>
          </div>
          <Switch
            id="loop-queue"
            checked={draft.loopQueue}
            disabled={disabled}
            onCheckedChange={(checked) =>
              setDraft({ ...draft, loopQueue: checked })
            }
          />
        </div>
        <div className="settings-info">
          <HardDrive size={18} />
          <p>
            The engine prepares media into a consistent broadcast format.
            Settings and queue changes apply to the next broadcast; stop playout
            before editing.
          </p>
        </div>
      </div>
      <div className="settings-footer">
        <span>
          HLS :8888 <span className="footer-separator">·</span> Local publish
          :8554
        </span>
        <Button type="submit" disabled={disabled}>
          <Check size={16} /> Save settings
        </Button>
      </div>
    </form>
  );
}
