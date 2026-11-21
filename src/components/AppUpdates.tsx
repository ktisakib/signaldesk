import { useEffect } from "react";
import { isTauri } from "@/lib/api";
import {
  Download,
  Loader2,
  RefreshCw,
  Sparkles,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStudio } from "@/lib/store";
import { useUpdater } from "@/lib/updater";

export default function AppUpdateBanner() {
  const { update, installing, statusMessage, error, install } = useUpdater();
  const status = useStudio((s) => s.status);
  const active = status?.state === "live" || status?.state === "starting";

  useEffect(() => {
    if (!isTauri()) return;
    void useUpdater.getState().check(false);
    const timer = setInterval(() => {
      void useUpdater.getState().check(false);
    }, 4 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  if (!isTauri() || (!update && !installing && !error)) return null;

  return (
    <div className="update-banner" role="status">
      <div className="update-banner-content">
        <Sparkles size={16} className="update-icon" />
        <div className="update-text">
          <strong>
            {installing
              ? "Installing update…"
              : update
                ? `SignalDesk v${update.version} is ready to install`
                : "Update notice"}
          </strong>
          {statusMessage && <p>{statusMessage}</p>}
        </div>
      </div>
      <div className="update-actions">
        {update && (
          <Button
            size="sm"
            disabled={installing || active}
            onClick={() => void install()}
          >
            {installing ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>Applying…</span>
              </>
            ) : (
              <>
                <Download size={14} />
                <span>Install & Restart</span>
              </>
            )}
          </Button>
        )}
        {update && active && (
          <small className="update-warn">Stop broadcast to install</small>
        )}
      </div>
    </div>
  );
}

export function TopbarUpdateAction() {
  const { update, checking, installing, check, install } = useUpdater();
  const status = useStudio((s) => s.status);
  const active = status?.state === "live" || status?.state === "starting";

  if (!isTauri()) return null;

  if (update) {
    return (
      <Button
        variant="default"
        size="sm"
        className="topbar-update-btn update-pulse"
        disabled={installing || active}
        onClick={() => void install()}
        title={`Install SignalDesk v${update.version}`}
      >
        {installing ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Sparkles size={13} />
        )}
        <span>Update to v{update.version}</span>
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="topbar-update-btn"
      disabled={checking || installing}
      onClick={() => void check(true)}
      title="Check for application updates"
    >
      <RefreshCw size={13} className={checking ? "animate-spin" : ""} />
      <span>{checking ? "Checking…" : "Check for updates"}</span>
    </Button>
  );
}

export function SettingsUpdateCard() {
  const {
    update,
    checking,
    installing,
    statusMessage,
    error,
    lastChecked,
    check,
    install,
  } = useUpdater();
  const status = useStudio((s) => s.status);
  const active = status?.state === "live" || status?.state === "starting";

  if (!isTauri()) return null;

  return (
    <section className="panel settings-update-panel">
      <div className="panel-heading">
        <div className="section-title">
          <h2>Application & software updates</h2>
          <span>Desktop broadcast application</span>
        </div>
        <Sparkles size={19} />
      </div>
      <div className="settings-body">
        <div className="update-card-status">
          <div className="update-status-row">
            <span className="update-label">Current Version</span>
            <span className="update-value font-mono">v0.1.10</span>
          </div>
          <div className="update-status-row">
            <span className="update-label">Update Status</span>
            <span className="update-value">
              {checking ? (
                <span className="update-status-indicator text-muted-foreground">
                  <Loader2 size={13} className="animate-spin" /> Checking for latest version…
                </span>
              ) : update ? (
                <span className="update-status-indicator text-emerald-400">
                  <Sparkles size={13} /> Version v{update.version} is available!
                </span>
              ) : error ? (
                <span className="update-status-indicator text-rose-400">
                  <AlertCircle size={13} /> {error}
                </span>
              ) : (
                <span className="update-status-indicator text-emerald-400">
                  <CheckCircle2 size={13} /> Up to date
                </span>
              )}
            </span>
          </div>
          {lastChecked && (
            <div className="update-status-row">
              <span className="update-label">Last Checked</span>
              <span className="update-value text-xs text-muted-foreground">
                {lastChecked.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          )}
          {statusMessage && <p className="update-info-msg">{statusMessage}</p>}
          {update?.notes && (
            <div className="update-notes">
              <strong>What’s new:</strong>
              <p>{update.notes}</p>
            </div>
          )}
        </div>
        <div className="update-card-actions">
          <Button
            type="button"
            variant="outline"
            disabled={checking || installing}
            onClick={() => void check(true)}
          >
            <RefreshCw size={14} className={checking ? "animate-spin" : ""} />
            <span>{checking ? "Checking for updates…" : "Check for updates"}</span>
          </Button>
          {update && (
            <Button
              type="button"
              variant="default"
              disabled={installing || active}
              onClick={() => void install()}
            >
              {installing ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Installing & Restarting…</span>
                </>
              ) : (
                <>
                  <Download size={14} />
                  <span>Install update v{update.version}</span>
                </>
              )}
            </Button>
          )}
          {update && active && (
            <p className="form-hint text-amber-300">
              Stop your live broadcast before installing updates.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
