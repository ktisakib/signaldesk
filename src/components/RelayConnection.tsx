import { useEffect, useState, type SubmitEvent } from "react";
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileCode,
  Key,
  Radio,
  RefreshCw,
  Server,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { useStudio } from "@/lib/store";
import { readRelayProfile } from "@/lib/relay";

interface Connection {
  channelName: string;
  host: string;
  port: number;
  viewerUrl: string;
  configured: boolean;
}

interface Status {
  state: string;
  error: string | null;
}

export default function RelayConnection() {
  const { connected } = useStudio();
  const [draft, setDraft] = useState<Connection>({
    channelName: "",
    host: "",
    port: 8890,
    viewerUrl: "",
    configured: false,
  });

  const [installation, setInstallation] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle", error: null });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Setup mode tab
  const [connectMethod, setConnectMethod] = useState<"license" | "file" | "manual">("license");

  // License activation fields
  const [licenseKey, setLicenseKey] = useState("");
  const [relayServerUrl, setRelayServerUrl] = useState("https://tv.pressmos.com");
  const [channelId, setChannelId] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("Broadcaster Laptop");

  // Manual fields
  const [manualKey, setManualKey] = useState("");
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState(8890);
  const [manualChannel, setManualChannel] = useState("");
  const [manualViewerUrl, setManualViewerUrl] = useState("https://tv.pressmos.com");

  useEffect(() => {
    let cancelled = false;
    if (!connected) return;

    void api<{ deviceId: string }>("/api/relay/device-id")
      .then((v) => setInstallation(v.deviceId))
      .catch((e) => setError(errorMessage(e)));

    void api<Connection>("/api/relay/config")
      .then((v) => {
        if (!cancelled) {
          setDraft(v);
          if (v.configured) {
            setManualHost(v.host);
            setManualPort(v.port);
            setManualChannel(v.channelName);
            setManualViewerUrl(v.viewerUrl);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });

    async function poll() {
      try {
        const s = await api<Status>("/api/relay/status");
        if (!cancelled) {
          setStatus(s);
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connected]);

  const active = status.state !== "idle";

  async function action(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      setStatus(await api<Status>("/api/relay/status"));
      setNotice(message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // 1. Activate with License Key directly
  async function activateLicense(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!licenseKey.trim() || !channelId.trim()) {
      setError("Please enter your License Key and assigned Channel ID.");
      return;
    }

    await action(async () => {
      const serverClean = relayServerUrl.trim().replace(/\/$/, "");
      const endpoint = `${serverClean}/api/control/license-activate`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: licenseKey.trim(),
          deviceId: installation,
          label: deviceLabel.trim() || "Broadcaster Laptop",
          channelId: channelId.trim().toLowerCase(),
        }),
      });

      if (!response.ok) {
        let msg = "Activation failed";
        try {
          const errData = await response.json();
          msg = errData.error || msg;
        } catch {
          msg = await response.text();
        }
        throw new Error(msg);
      }

      const data = await response.json();
      if (!data.profile) {
        throw new Error("Server did not return a broadcaster profile.");
      }

      // Save directly to local engine
      const saved = await api<Connection>("/api/relay/config", "PUT", data.profile);
      setDraft(saved);
      setLicenseKey("");
    }, "License verified and broadcaster profile activated! You can now start broadcasting to the relay.");
  }

  // 2. Import Connection Profile file
  async function importProfile(file: File | undefined) {
    if (!file) return;
    await action(async () => {
      if (file.size > 8192) throw new Error("Connection profile is too large.");
      const profile = readRelayProfile(await file.text());
      const saved = await api<Connection>("/api/relay/config", "PUT", profile);
      setDraft(saved);
    }, "Connection profile imported and saved successfully.");
  }

  // 3. Save manual connection
  function saveManual(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    void action(async () => {
      const value = await api<Connection>("/api/relay/config", "PUT", {
        channelName: manualChannel.trim(),
        host: manualHost.trim(),
        port: manualPort,
        viewerUrl: manualViewerUrl.trim(),
        ...(manualKey ? { streamKey: manualKey.trim() } : {}),
      });
      setDraft(value);
      setManualKey("");
    }, "Connection settings saved.");
  }

  // Copy installation ID helper
  function copyInstallationId() {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(installation);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const playback = `${draft.viewerUrl.replace(/\/$/, "")}/streams/${draft.channelName}/index.m3u8`;

  return (
    <div className="relay-layout" style={{ maxWidth: "980px", margin: "0 auto" }}>
      {/* Active Broadcaster Status Card */}
      {draft.configured ? (
        <article className="panel relay-panel" style={{ background: "#141a17", border: "1px solid #232c26", borderRadius: "12px", padding: "24px" }}>
          <div className="panel-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ width: "36px", height: "36px", borderRadius: "8px", background: active ? "#163321" : "#1c2520", border: `1px solid ${active ? "#2f5c3d" : "#2d3b31"}`, display: "grid", placeItems: "center", color: active ? "#4ade80" : "#b5edce" }}>
                <Radio size={20} />
              </div>
              <div>
                <h2 style={{ fontSize: "17px", fontWeight: "650", color: "#f0f5f2", margin: 0 }}>
                  Channel: {draft.channelName}
                </h2>
                <div style={{ fontSize: "12px", color: "#819387" }}>
                  Server: {draft.host}:{draft.port} (SRT)
                </div>
              </div>
            </div>

            <span
              className={`pill ${active ? "live" : ""}`}
              style={{
                padding: "4px 12px",
                borderRadius: "20px",
                fontSize: "11px",
                fontWeight: "600",
                letterSpacing: "0.04em",
                background: active ? "rgba(34, 197, 94, 0.15)" : "rgba(148, 163, 184, 0.1)",
                color: active ? "#4ade80" : "#94a3b8",
                border: `1px solid ${active ? "rgba(34, 197, 94, 0.3)" : "rgba(148, 163, 184, 0.2)"}`,
              }}
            >
              {active ? "● ON AIR (RELAY ACTIVE)" : "STANDBY (READY)"}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", background: "#111613", padding: "16px", borderRadius: "8px", border: "1px solid #202923", marginBottom: "20px" }}>
            <div>
              <span style={{ fontSize: "11px", color: "#74877b", display: "block" }}>CHANNEL ID</span>
              <strong style={{ fontSize: "13px", color: "#e8ede9", fontFamily: "monospace" }}>{draft.channelName}</strong>
            </div>
            <div>
              <span style={{ fontSize: "11px", color: "#74877b", display: "block" }}>RELAY SERVER</span>
              <strong style={{ fontSize: "13px", color: "#e8ede9", fontFamily: "monospace" }}>{draft.host}:{draft.port}</strong>
            </div>
            <div>
              <span style={{ fontSize: "11px", color: "#74877b", display: "block" }}>LICENSE STATUS</span>
              <span style={{ fontSize: "12px", color: "#86efac", fontWeight: "600" }}>✓ Licensed Broadcaster</span>
            </div>
            <div>
              <span style={{ fontSize: "11px", color: "#74877b", display: "block" }}>PUBLIC PLAYBACK</span>
              <a href={playback} target="_blank" rel="noreferrer" style={{ fontSize: "11px", color: "#b5edce", textDecoration: "underline", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span>Open M3U8</span> <ExternalLink size={11} />
              </a>
            </div>
          </div>

          {/* Broadcaster Actions */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
            <Button
              disabled={!connected || busy}
              onClick={() =>
                void action(
                  () => api(`/api/relay/${active ? "stop" : "start"}`, "POST", {}),
                  active ? "Relay broadcast stopped." : "Broadcasting live to the relay server! Your signal is on air.",
                )
              }
              style={{
                background: active ? "#ef4444" : "#b5edce",
                color: active ? "#ffffff" : "#0d1e15",
                fontWeight: "600",
                minHeight: "40px",
                padding: "0 20px",
              }}
            >
              {active ? (
                <>
                  <WifiOff size={16} style={{ marginRight: "6px" }} /> Stop Broadcasting
                </>
              ) : (
                <>
                  <Wifi size={16} style={{ marginRight: "6px" }} /> Go Live to Server
                </>
              )}
            </Button>

            <Button
              variant="outline"
              disabled={busy || !connected}
              onClick={() =>
                void action(
                  () => api("/api/relay/test", "POST", {}),
                  "Relay server reachable and channel verified.",
                )
              }
              style={{ minHeight: "40px", borderColor: "#2b3930", color: "#cad8ce" }}
            >
              <RefreshCw size={14} style={{ marginRight: "6px" }} /> Test Connection
            </Button>

            <Button
              variant="ghost"
              disabled={busy || active}
              onClick={() => {
                if (window.confirm("Remove this saved channel configuration and disconnect?")) {
                  void action(async () => {
                    await api("/api/relay/config", "DELETE");
                    setDraft({ channelName: "", host: "", port: 8890, viewerUrl: "", configured: false });
                  }, "Connection removed.");
                }
              }}
              style={{ marginLeft: "auto", color: "#7d8f82", minHeight: "40px" }}
            >
              Change License / Reconnect
            </Button>
          </div>
        </article>
      ) : (
        /* Configuration & License Setup Panel */
        <article className="panel relay-panel" style={{ background: "#141a17", border: "1px solid #232c26", borderRadius: "12px", padding: "28px" }}>
          <div className="panel-heading" style={{ marginBottom: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ width: "38px", height: "38px", borderRadius: "8px", background: "#1c2520", border: "1px solid #2d3b31", display: "grid", placeItems: "center", color: "#b5edce" }}>
                <Key size={20} />
              </div>
              <div>
                <h2 style={{ fontSize: "18px", fontWeight: "650", color: "#f0f5f2", margin: 0 }}>
                  Broadcaster License & Server Setup
                </h2>
                <p style={{ fontSize: "12.5px", color: "#819387", margin: "2px 0 0" }}>
                  Connect your broadcaster laptop to the shared channel on the server.
                </p>
              </div>
            </div>
          </div>

          {/* Installation ID Chip */}
          <div style={{ background: "#111613", padding: "12px 16px", borderRadius: "8px", border: "1px solid #202923", marginBottom: "24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
            <div>
              <span style={{ fontSize: "11px", color: "#708377", display: "block" }}>THIS COMPUTER&apos;S HARDWARE INSTALLATION ID</span>
              <code style={{ fontSize: "12px", color: "#b5edce", fontFamily: "monospace" }}>{installation || "Detecting installation ID..."}</code>
            </div>
            {installation && (
              <Button size="xs" variant="outline" onClick={copyInstallationId} style={{ borderColor: "#2b3930", color: "#c6d6cb" }}>
                {copied ? <Check size={12} style={{ color: "#4ade80", marginRight: "4px" }} /> : <Copy size={12} style={{ marginRight: "4px" }} />}
                {copied ? "Copied" : "Copy ID"}
              </Button>
            )}
          </div>

          {/* Setup Method Selector */}
          <div style={{ display: "flex", gap: "4px", borderBottom: "1px solid #222b25", marginBottom: "20px" }}>
            <button
              onClick={() => setConnectMethod("license")}
              style={{
                padding: "8px 16px",
                fontSize: "12.5px",
                fontWeight: "600",
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${connectMethod === "license" ? "#b5edce" : "transparent"}`,
                color: connectMethod === "license" ? "#b5edce" : "#809286",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <Key size={14} /> License Key (Recommended)
            </button>
            <button
              onClick={() => setConnectMethod("file")}
              style={{
                padding: "8px 16px",
                fontSize: "12.5px",
                fontWeight: "600",
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${connectMethod === "file" ? "#b5edce" : "transparent"}`,
                color: connectMethod === "file" ? "#b5edce" : "#809286",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <FileCode size={14} /> Import Profile File
            </button>
            <button
              onClick={() => setConnectMethod("manual")}
              style={{
                padding: "8px 16px",
                fontSize: "12.5px",
                fontWeight: "600",
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${connectMethod === "manual" ? "#b5edce" : "transparent"}`,
                color: connectMethod === "manual" ? "#b5edce" : "#809286",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <Server size={14} /> Manual Server Details
            </button>
          </div>

          {/* 1. LICENSE KEY ACTIVATION FORM */}
          {connectMethod === "license" && (
            <form onSubmit={activateLicense} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <p style={{ fontSize: "12px", color: "#8a9e91", margin: 0, lineHeight: "1.5" }}>
                Enter the license key provided by your administrator. This computer will automatically register its hardware slot and configure broadcasting.
              </p>

              <div>
                <label htmlFor="client-lic-key" style={{ fontSize: "12px", fontWeight: "550", color: "#c6d7cb", display: "block", marginBottom: "6px" }}>
                  License Key
                </label>
                <Input
                  id="client-lic-key"
                  type="password"
                  required
                  placeholder="Paste license key provided by admin..."
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value)}
                  style={{ background: "#111713", borderColor: "#253229" }}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div>
                  <label htmlFor="client-channel" style={{ fontSize: "12px", fontWeight: "550", color: "#c6d7cb", display: "block", marginBottom: "6px" }}>
                    Assigned Channel ID
                  </label>
                  <Input
                    id="client-channel"
                    required
                    placeholder="e.g. laptop-a"
                    value={channelId}
                    onChange={(e) => setChannelId(e.target.value.toLowerCase().trim())}
                    style={{ background: "#111713", borderColor: "#253229" }}
                  />
                  <span style={{ fontSize: "11px", color: "#6b7d72", marginTop: "4px", display: "block" }}>Provided by your administrator</span>
                </div>

                <div>
                  <label htmlFor="client-server" style={{ fontSize: "12px", fontWeight: "550", color: "#c6d7cb", display: "block", marginBottom: "6px" }}>
                    Relay Server URL
                  </label>
                  <Input
                    id="client-server"
                    required
                    type="url"
                    value={relayServerUrl}
                    onChange={(e) => setRelayServerUrl(e.target.value)}
                    style={{ background: "#111713", borderColor: "#253229" }}
                  />
                  <span style={{ fontSize: "11px", color: "#6b7d72", marginTop: "4px", display: "block" }}>Default: https://tv.pressmos.com</span>
                </div>
              </div>

              <div>
                <label htmlFor="client-label" style={{ fontSize: "12px", fontWeight: "550", color: "#c6d7cb", display: "block", marginBottom: "6px" }}>
                  Device Name / Location
                </label>
                <Input
                  id="client-label"
                  placeholder="e.g. Newsroom Studio Laptop A"
                  value={deviceLabel}
                  onChange={(e) => setDeviceLabel(e.target.value)}
                  style={{ background: "#111713", borderColor: "#253229" }}
                />
              </div>

              <div style={{ paddingTop: "8px" }}>
                <Button
                  type="submit"
                  disabled={!connected || busy || !licenseKey.trim() || !channelId.trim()}
                  style={{ background: "#b5edce", color: "#0d1e15", fontWeight: "600", minHeight: "40px", padding: "0 24px" }}
                >
                  <Key size={15} style={{ marginRight: "6px" }} /> Activate License & Connect
                </Button>
              </div>
            </form>
          )}

          {/* 2. IMPORT PROFILE FILE */}
          {connectMethod === "file" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <p style={{ fontSize: "12px", color: "#8a9e91", margin: 0, lineHeight: "1.5" }}>
                If your administrator exported a <code style={{ color: "#b5edce" }}>.connection.json</code> file, choose it below to configure this computer instantly.
              </p>

              <div style={{ border: "2px dashed #26342b", borderRadius: "10px", padding: "32px 20px", textAlign: "center", background: "#111613" }}>
                <FileCode size={32} style={{ color: "#b5edce", margin: "0 auto 12px" }} />
                <label htmlFor="relay-profile-upload" style={{ cursor: "pointer", display: "inline-block" }}>
                  <span style={{ fontSize: "13px", fontWeight: "600", color: "#b5edce", textDecoration: "underline" }}>
                    Select .connection.json file
                  </span>
                  <input
                    id="relay-profile-upload"
                    type="file"
                    accept=".json,application/json"
                    disabled={!connected || busy || active}
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      void importProfile(file);
                    }}
                  />
                </label>
                <p style={{ fontSize: "11.5px", color: "#6b7d72", margin: "8px 0 0" }}>
                  Keep this file private: it contains your channel publishing key.
                </p>
              </div>
            </div>
          )}

          {/* 3. MANUAL SETTINGS */}
          {connectMethod === "manual" && (
            <form onSubmit={saveManual} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "12px" }}>
                <div>
                  <label htmlFor="man-host" style={{ fontSize: "12px", fontWeight: "550", color: "#c6d7cb", display: "block", marginBottom: "4px" }}>
                    Relay IP or Hostname
                  </label>
                  <Input
                    id="man-host"
                    required
                    placeholder="103.140.205.192 or tv.pressmos.com"
                    value={manualHost}
                    onChange={(e) => setManualHost(e.target.value)}
                    style={{ background: "#111713", borderColor: "#253229" }}
                  />
                </div>
                <div>
                  <label htmlFor="man-port" style={{ fontSize: "12px", fontWeight: "550", color: "#c6d7cb", display: "block", marginBottom: "4px" }}>
                    SRT UDP Port
                  </label>
                  <Input
                    id="man-port"
                    type="number"
                    required
                    value={manualPort}
                    onChange={(e) => setManualPort(Number(e.target.value))}
                    style={{ background: "#111713", borderColor: "#253229" }}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="man-channel" style={{ fontSize: "12px", fontWeight: "550", color: "#c6d7cb", display: "block", marginBottom: "4px" }}>
                  Channel ID
                </label>
                <Input
                  id="man-channel"
                  required
                  placeholder="e.g. laptop-a"
                  value={manualChannel}
                  onChange={(e) => setManualChannel(e.target.value)}
                  style={{ background: "#111713", borderColor: "#253229" }}
                />
              </div>

              <div>
                <label htmlFor="man-key" style={{ fontSize: "12px", fontWeight: "550", color: "#c6d7cb", display: "block", marginBottom: "4px" }}>
                  Publishing Key / Passphrase
                </label>
                <Input
                  id="man-key"
                  type="password"
                  placeholder="Publishing key from administrator..."
                  value={manualKey}
                  onChange={(e) => setManualKey(e.target.value)}
                  style={{ background: "#111713", borderColor: "#253229" }}
                />
              </div>

              <div>
                <label htmlFor="man-web" style={{ fontSize: "12px", fontWeight: "550", color: "#c6d7cb", display: "block", marginBottom: "4px" }}>
                  Web Origin URL
                </label>
                <Input
                  id="man-web"
                  required
                  value={manualViewerUrl}
                  onChange={(e) => setManualViewerUrl(e.target.value)}
                  style={{ background: "#111713", borderColor: "#253229" }}
                />
              </div>

              <div style={{ paddingTop: "6px" }}>
                <Button type="submit" disabled={!connected || busy} style={{ background: "#b5edce", color: "#0d1e15", fontWeight: "600" }}>
                  Save Manual Connection
                </Button>
              </div>
            </form>
          )}
        </article>
      )}

      {/* Notifications and Alerts */}
      {error && (
        <div style={{ marginTop: "16px", padding: "12px 16px", borderRadius: "8px", background: "rgba(239, 68, 68, 0.12)", border: "1px solid rgba(239, 68, 68, 0.3)", color: "#fca5a5", fontSize: "13px", display: "flex", alignItems: "center", gap: "8px" }}>
          <span>{error}</span>
          <button onClick={() => setError("")} style={{ marginLeft: "auto", background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
            <X size={14} />
          </button>
        </div>
      )}

      {notice && (
        <div style={{ marginTop: "16px", padding: "12px 16px", borderRadius: "8px", background: "rgba(34, 197, 94, 0.12)", border: "1px solid rgba(34, 197, 94, 0.3)", color: "#86efac", fontSize: "13px", display: "flex", alignItems: "center", gap: "8px" }}>
          <CheckCircle2 size={16} />
          <span>{notice}</span>
          <button onClick={() => setNotice("")} style={{ marginLeft: "auto", background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
