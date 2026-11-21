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
  ShieldCheck,
  Sparkles,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { useStudio } from "@/lib/store";
import { readRelayProfile, relayStatusLabel } from "@/lib/relay";

// Built-in relay defaults: IP, ports, and credentials are set internally
const DEFAULT_RELAY_SERVER = "https://tv.pressmos.com";
const DEFAULT_RELAY_HOST = "tv.pressmos.com";
const DEFAULT_SRT_PORT = 8890;
const DEFAULT_VIEWER_URL = "https://tv.pressmos.com";

const PRESET_CHANNELS = [
  { id: "laptop-a", name: "Broadcaster Laptop A (Main)" },
  { id: "laptop-b", name: "Broadcaster Laptop B (Secondary)" },
];

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
    port: DEFAULT_SRT_PORT,
    viewerUrl: "",
    configured: false,
  });

  const [installation, setInstallation] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle", error: null });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Setup mode tab: 'client' (license activation), 'admin' (zero license direct), 'file' (profile), 'manual'
  const [connectMethod, setConnectMethod] = useState<"client" | "admin" | "file" | "manual">("client");

  // Client License activation fields (server IP and ports are handled internally)
  const [licenseKey, setLicenseKey] = useState("");
  const [channelId, setChannelId] = useState("laptop-a");
  const [deviceLabel, setDeviceLabel] = useState("Broadcaster Laptop");

  // Admin Direct fields (NO license required)
  const [adminToken, setAdminToken] = useState(() => {
    return (typeof window !== "undefined" && localStorage.getItem("signaldesk_admin_token")) || "";
  });
  const [adminChannel, setAdminChannel] = useState("laptop-a");
  const [isAdminConnection, setIsAdminConnection] = useState(false);

  // Manual fields
  const [manualKey, setManualKey] = useState("");
  const [manualHost, setManualHost] = useState(DEFAULT_RELAY_HOST);
  const [manualPort, setManualPort] = useState(DEFAULT_SRT_PORT);
  const [manualChannel, setManualChannel] = useState("laptop-a");
  const [manualViewerUrl, setManualViewerUrl] = useState(DEFAULT_VIEWER_URL);

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
            setManualHost(v.host || DEFAULT_RELAY_HOST);
            setManualPort(v.port || DEFAULT_SRT_PORT);
            setManualChannel(v.channelName);
            setManualViewerUrl(v.viewerUrl || DEFAULT_VIEWER_URL);
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
  const live = status.state === "live";

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

  // 1. Client License Key Activation (IP and credentials set internally)
  async function activateLicense(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const targetChannel = channelId.trim().toLowerCase();
    if (!licenseKey.trim() || !targetChannel) {
      setError("Please enter your License Key and choose your assigned channel.");
      return;
    }

    await action(async () => {
      const endpoint = `${DEFAULT_RELAY_SERVER}/api/control/license-activate`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: licenseKey.trim(),
          deviceId: installation,
          label: deviceLabel.trim() || "Broadcaster Laptop",
          channelId: targetChannel,
        }),
      });

      if (!response.ok) {
        let msg = "License activation failed";
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

      // Ensure internal defaults are baked in
      const profileToSave = {
        ...data.profile,
        host: data.profile.host || DEFAULT_RELAY_HOST,
        port: data.profile.port || DEFAULT_SRT_PORT,
        viewerUrl: data.profile.viewerUrl || DEFAULT_VIEWER_URL,
      };

      const saved = await api<Connection>("/api/relay/config", "PUT", profileToSave);
      setDraft(saved);
      setLicenseKey("");
      setIsAdminConnection(false);
    }, "License verified! Broadcaster profile activated. You are ready to go live.");
  }

  // 2. Admin Direct Connect (NO LICENSE NEEDED - ADMIN CAN DO EVERYTHING)
  async function connectAsAdmin(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const token = adminToken.trim();
    const targetChannel = adminChannel.trim().toLowerCase();

    if (!token) {
      setError("Please enter the Relay Administrator Token.");
      return;
    }
    if (!targetChannel) {
      setError("Please select or enter the channel you wish to broadcast on.");
      return;
    }

    await action(async () => {
      // Fetch channel secret directly using admin authorization
      const res = await fetch(`${DEFAULT_RELAY_SERVER}/api/channels/${targetChannel}/connection`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        let err = "Failed to authenticate administrator token with relay server";
        try {
          const json = await res.json();
          err = json.error || err;
        } catch {
          err = await res.text();
        }
        throw new Error(err);
      }

      const data = await res.json();
      const streamKey = data.streamKey;
      if (!streamKey) {
        throw new Error("Relay server did not return a publishing key for this channel.");
      }

      // Configure the local engine with admin bypass
      const saved = await api<Connection>("/api/relay/config", "PUT", {
        channelName: targetChannel,
        host: DEFAULT_RELAY_HOST,
        port: DEFAULT_SRT_PORT,
        viewerUrl: DEFAULT_VIEWER_URL,
        streamKey,
        deviceToken: token,
        deviceId: "admin",
      });

      if (typeof window !== "undefined") {
        localStorage.setItem("signaldesk_admin_token", token);
      }

      setDraft(saved);
      setIsAdminConnection(true);
    }, `Connected to channel "${targetChannel}" as Administrator. Zero license required!`);
  }

  // 3. Import Connection Profile file
  async function importProfile(file: File | undefined) {
    if (!file) return;
    await action(async () => {
      if (file.size > 8192) throw new Error("Connection profile is too large.");
      const profile = readRelayProfile(await file.text());
      const saved = await api<Connection>("/api/relay/config", "PUT", profile);
      setDraft(saved);
      setIsAdminConnection(false);
    }, "Connection profile imported and saved successfully.");
  }

  // 4. Save manual connection
  function saveManual(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    void action(async () => {
      const value = await api<Connection>("/api/relay/config", "PUT", {
        channelName: manualChannel.trim(),
        host: manualHost.trim() || DEFAULT_RELAY_HOST,
        port: manualPort || DEFAULT_SRT_PORT,
        viewerUrl: manualViewerUrl.trim() || DEFAULT_VIEWER_URL,
        ...(manualKey ? { streamKey: manualKey.trim() } : {}),
      });
      setDraft(value);
      setManualKey("");
      setIsAdminConnection(false);
    }, "Connection settings saved.");
  }

  function copyInstallationId() {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(installation);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const playback = `${(draft.viewerUrl || DEFAULT_VIEWER_URL).replace(/\/$/, "")}/streams/${draft.channelName}/index.m3u8`;

  return (
    <div className="relay-layout" style={{ maxWidth: "980px", margin: "0 auto" }}>
      {/* Active Broadcaster Status Card */}
      {draft.configured ? (
        <article
          className="panel relay-panel"
          style={{
            background: "#141a17",
            border: "1px solid #232c26",
            borderRadius: "12px",
            padding: "24px",
          }}
        >
          <div
            className="panel-heading"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "16px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "8px",
                  background: live ? "#163321" : "#1c2520",
                  border: `1px solid ${live ? "#2f5c3d" : "#2d3b31"}`,
                  display: "grid",
                  placeItems: "center",
                  color: live ? "#4ade80" : "#b5edce",
                }}
              >
                <Radio size={20} />
              </div>
              <div>
                <h2
                  style={{
                    fontSize: "17px",
                    fontWeight: "650",
                    color: "#f0f5f2",
                    margin: 0,
                  }}
                >
                  Channel: {draft.channelName}
                </h2>
                <div style={{ fontSize: "12px", color: "#819387" }}>
                  Server: {draft.host}:{draft.port} (SRT)
                </div>
              </div>
            </div>

            <span
              className={`pill ${live ? "live" : ""}`}
              style={{
                padding: "4px 12px",
                borderRadius: "20px",
                fontSize: "11px",
                fontWeight: "600",
                letterSpacing: "0.04em",
                background: live
                  ? "rgba(34, 197, 94, 0.15)"
                  : "rgba(148, 163, 184, 0.1)",
                color: live ? "#4ade80" : "#94a3b8",
                border: `1px solid ${
                  live ? "rgba(34, 197, 94, 0.3)" : "rgba(148, 163, 184, 0.2)"
                }`,
              }}
            >
              {relayStatusLabel(status.state)}
            </span>
          </div>

          {status.error && <p role="alert">{status.error}</p>}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "12px",
              background: "#111613",
              padding: "16px",
              borderRadius: "8px",
              border: "1px solid #202923",
              marginBottom: "20px",
            }}
          >
            <div>
              <span style={{ fontSize: "11px", color: "#74877b", display: "block" }}>
                CHANNEL ID
              </span>
              <strong style={{ fontSize: "13px", color: "#e8ede9", fontFamily: "monospace" }}>
                {draft.channelName}
              </strong>
            </div>
            <div>
              <span style={{ fontSize: "11px", color: "#74877b", display: "block" }}>
                TRANSMISSION RELAY
              </span>
              <strong style={{ fontSize: "13px", color: "#e8ede9", fontFamily: "monospace" }}>
                {draft.host}:{draft.port}
              </strong>
            </div>
            <div>
              <span style={{ fontSize: "11px", color: "#74877b", display: "block" }}>
                AUTHORIZATION
              </span>
              {isAdminConnection ? (
                <span
                  style={{
                    fontSize: "12px",
                    color: "#f59e0b",
                    fontWeight: "600",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <ShieldCheck size={14} /> Admin Direct Mode (No License Needed)
                </span>
              ) : (
                <span style={{ fontSize: "12px", color: "#86efac", fontWeight: "600" }}>
                  ✓ Licensed Broadcaster
                </span>
              )}
            </div>
            <div>
              <span style={{ fontSize: "11px", color: "#74877b", display: "block" }}>
                PUBLIC PLAYBACK
              </span>
              <a
                href={playback}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontSize: "11px",
                  color: "#b5edce",
                  textDecoration: "underline",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
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
                  active
                    ? "Relay broadcast stopped."
                    : "Relay output enabled. Waiting for the publishing connection.",
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
                  "Relay web address reachable and channel registered. This does not verify the publishing key or live playback.",
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
                if (window.confirm("Disconnect and choose another channel or account?")) {
                  void action(async () => {
                    await api("/api/relay/config", "DELETE");
                    setDraft({
                      channelName: "",
                      host: "",
                      port: DEFAULT_SRT_PORT,
                      viewerUrl: "",
                      configured: false,
                    });
                    setIsAdminConnection(false);
                  }, "Connection removed.");
                }
              }}
              style={{ marginLeft: "auto", color: "#7d8f82", minHeight: "40px" }}
            >
              Change Channel / Reconnect
            </Button>
          </div>
        </article>
      ) : (
        /* Configuration Panel */
        <article
          className="panel relay-panel"
          style={{
            background: "#141a17",
            border: "1px solid #232c26",
            borderRadius: "12px",
            padding: "28px",
          }}
        >
          <div className="panel-heading" style={{ marginBottom: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: "38px",
                  height: "38px",
                  borderRadius: "8px",
                  background: "#1c2520",
                  border: "1px solid #2d3b31",
                  display: "grid",
                  placeItems: "center",
                  color: "#b5edce",
                }}
              >
                <Radio size={20} />
              </div>
              <div>
                <h2 style={{ fontSize: "18px", fontWeight: "650", color: "#f0f5f2", margin: 0 }}>
                  Transmission Server Connection
                </h2>
                <p style={{ fontSize: "12.5px", color: "#819387", margin: "2px 0 0" }}>
                  Relay IP and server configuration are managed internally. Choose your role below.
                </p>
              </div>
            </div>
          </div>

          {/* Setup Method Selector */}
          <div
            style={{
              display: "flex",
              gap: "6px",
              borderBottom: "1px solid #222b25",
              marginBottom: "24px",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={() => setConnectMethod("client")}
              style={{
                padding: "10px 18px",
                fontSize: "13px",
                fontWeight: "600",
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${connectMethod === "client" ? "#b5edce" : "transparent"}`,
                color: connectMethod === "client" ? "#b5edce" : "#809286",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <Key size={15} /> Client License Activation
            </button>
            <button
              type="button"
              onClick={() => setConnectMethod("admin")}
              style={{
                padding: "10px 18px",
                fontSize: "13px",
                fontWeight: "600",
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${connectMethod === "admin" ? "#f59e0b" : "transparent"}`,
                color: connectMethod === "admin" ? "#f59e0b" : "#809286",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <ShieldCheck size={15} /> Administrator Mode (No License Needed)
            </button>
            <button
              type="button"
              onClick={() => setConnectMethod("file")}
              style={{
                padding: "10px 14px",
                fontSize: "12px",
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
              <FileCode size={14} /> Profile File
            </button>
            <button
              type="button"
              onClick={() => setConnectMethod("manual")}
              style={{
                padding: "10px 14px",
                fontSize: "12px",
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
              <Server size={14} /> Manual / Custom
            </button>
          </div>

          {/* 1. CLIENT LICENSE KEY ACTIVATION FORM */}
          {connectMethod === "client" && (
            <form onSubmit={activateLicense} style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
              <div
                style={{
                  background: "rgba(181, 237, 206, 0.05)",
                  border: "1px solid rgba(181, 237, 206, 0.15)",
                  padding: "14px 18px",
                  borderRadius: "8px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                  <Sparkles size={15} style={{ color: "#b5edce" }} />
                  <strong style={{ fontSize: "13px", color: "#f0f5f2" }}>Zero Server Setup for Clients</strong>
                </div>
                <p style={{ fontSize: "12px", color: "#8a9e91", margin: 0, lineHeight: "1.5" }}>
                  Relay server (<code style={{ color: "#b5edce" }}>tv.pressmos.com:8890</code>) is configured internally. Simply select your channel and paste your license key.
                </p>
              </div>

              {/* Channel Selector */}
              <div>
                <label style={{ fontSize: "12.5px", fontWeight: "600", color: "#c6d7cb", display: "block", marginBottom: "8px" }}>
                  Select Your Assigned Channel
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
                  {PRESET_CHANNELS.map((ch) => (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => setChannelId(ch.id)}
                      style={{
                        padding: "12px 14px",
                        textAlign: "left",
                        borderRadius: "8px",
                        background: channelId === ch.id ? "#1d2922" : "#111613",
                        border: `1.5px solid ${channelId === ch.id ? "#b5edce" : "#243228"}`,
                        cursor: "pointer",
                        color: channelId === ch.id ? "#f0f5f2" : "#9caea2",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <strong style={{ fontSize: "13px", display: "block" }}>{ch.name}</strong>
                      <span style={{ fontSize: "11px", color: "#718477", fontFamily: "monospace" }}>ID: {ch.id}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* License Key Field */}
              <div>
                <label
                  htmlFor="client-lic-key"
                  style={{ fontSize: "12.5px", fontWeight: "600", color: "#c6d7cb", display: "block", marginBottom: "6px" }}
                >
                  License Key
                </label>
                <Input
                  id="client-lic-key"
                  type="password"
                  required
                  placeholder="Paste your client license key provided by the admin..."
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value)}
                  style={{ background: "#111713", borderColor: "#253229", height: "42px" }}
                />
              </div>

              {/* Device Label */}
              <div>
                <label
                  htmlFor="client-label"
                  style={{ fontSize: "12px", fontWeight: "500", color: "#9caea2", display: "block", marginBottom: "6px" }}
                >
                  Device Name / Station
                </label>
                <Input
                  id="client-label"
                  placeholder="e.g. Broadcaster Laptop A"
                  value={deviceLabel}
                  onChange={(e) => setDeviceLabel(e.target.value)}
                  style={{ background: "#111713", borderColor: "#253229" }}
                />
              </div>

              {/* Installation ID Note */}
              <div
                style={{
                  background: "#111613",
                  padding: "10px 14px",
                  borderRadius: "6px",
                  border: "1px solid #1f2822",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                }}
              >
                <div>
                  <span style={{ fontSize: "11px", color: "#708377", display: "block" }}>
                    HARDWARE INSTALLATION ID
                  </span>
                  <code style={{ fontSize: "11.5px", color: "#b5edce", fontFamily: "monospace" }}>
                    {installation || "Detecting..."}
                  </code>
                </div>
                {installation && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={copyInstallationId}
                    style={{ borderColor: "#2b3930", color: "#c6d6cb" }}
                  >
                    {copied ? <Check size={12} style={{ color: "#4ade80", marginRight: "4px" }} /> : <Copy size={12} style={{ marginRight: "4px" }} />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                )}
              </div>

              <div style={{ paddingTop: "6px" }}>
                <Button
                  type="submit"
                  disabled={!connected || busy || !licenseKey.trim() || !channelId.trim()}
                  style={{
                    background: "#b5edce",
                    color: "#0d1e15",
                    fontWeight: "600",
                    minHeight: "42px",
                    padding: "0 28px",
                    fontSize: "13.5px",
                  }}
                >
                  <Key size={16} style={{ marginRight: "6px" }} /> Activate License & Connect
                </Button>
              </div>
            </form>
          )}

          {/* 2. ADMINISTRATOR MODE (NO LICENSE NEEDED) */}
          {connectMethod === "admin" && (
            <form onSubmit={connectAsAdmin} style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
              <div
                style={{
                  background: "rgba(245, 158, 11, 0.08)",
                  border: "1px solid rgba(245, 158, 11, 0.25)",
                  padding: "14px 18px",
                  borderRadius: "8px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                  <ShieldCheck size={16} style={{ color: "#f59e0b" }} />
                  <strong style={{ fontSize: "13px", color: "#fbbf24" }}>
                    Administrator Direct Access · No License Required
                  </strong>
                </div>
                <p style={{ fontSize: "12px", color: "#d97706", margin: 0, lineHeight: "1.5" }}>
                  Admins have unrestricted broadcast capabilities. You do not need a license key or hardware registration. Simply enter your Administrator Token to broadcast on any channel.
                </p>
              </div>

              {/* Admin Channel Selection */}
              <div>
                <label style={{ fontSize: "12.5px", fontWeight: "600", color: "#c6d7cb", display: "block", marginBottom: "8px" }}>
                  Channel to Broadcast On
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
                  {PRESET_CHANNELS.map((ch) => (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => setAdminChannel(ch.id)}
                      style={{
                        padding: "12px 14px",
                        textAlign: "left",
                        borderRadius: "8px",
                        background: adminChannel === ch.id ? "#292113" : "#111613",
                        border: `1.5px solid ${adminChannel === ch.id ? "#f59e0b" : "#243228"}`,
                        cursor: "pointer",
                        color: adminChannel === ch.id ? "#fde68a" : "#9caea2",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <strong style={{ fontSize: "13px", display: "block" }}>{ch.name}</strong>
                      <span style={{ fontSize: "11px", color: "#718477", fontFamily: "monospace" }}>ID: {ch.id}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Admin Token Input */}
              <div>
                <label
                  htmlFor="admin-token"
                  style={{ fontSize: "12.5px", fontWeight: "600", color: "#c6d7cb", display: "block", marginBottom: "6px" }}
                >
                  Relay Administrator Token
                </label>
                <Input
                  id="admin-token"
                  type="password"
                  required
                  placeholder="Enter your secret RELAY_ADMIN_TOKEN..."
                  value={adminToken}
                  onChange={(e) => setAdminToken(e.target.value)}
                  style={{ background: "#111713", borderColor: "#253229", height: "42px" }}
                />
                <span style={{ fontSize: "11px", color: "#6b7d72", marginTop: "4px", display: "block" }}>
                  Saved securely to this app’s memory. Bypasses all client licensing.
                </span>
              </div>

              <div style={{ paddingTop: "6px" }}>
                <Button
                  type="submit"
                  disabled={!connected || busy || !adminToken.trim() || !adminChannel.trim()}
                  style={{
                    background: "#f59e0b",
                    color: "#18181b",
                    fontWeight: "600",
                    minHeight: "42px",
                    padding: "0 28px",
                    fontSize: "13.5px",
                  }}
                >
                  <ShieldCheck size={16} style={{ marginRight: "6px" }} /> Connect & Broadcast as Admin
                </Button>
              </div>
            </form>
          )}

          {/* 3. IMPORT PROFILE FILE */}
          {connectMethod === "file" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <p style={{ fontSize: "12px", color: "#8a9e91", margin: 0, lineHeight: "1.5" }}>
                If you have an exported <code style={{ color: "#b5edce" }}>.connection.json</code> file, choose it below to configure this computer instantly.
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

          {/* 4. MANUAL SETTINGS */}
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
        <div
          style={{
            marginTop: "16px",
            padding: "12px 16px",
            borderRadius: "8px",
            background: "rgba(239, 68, 68, 0.12)",
            border: "1px solid rgba(239, 68, 68, 0.3)",
            color: "#fca5a5",
            fontSize: "13px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span>{error}</span>
          <button
            onClick={() => setError("")}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "inherit", cursor: "pointer" }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {notice && (
        <div
          style={{
            marginTop: "16px",
            padding: "12px 16px",
            borderRadius: "8px",
            background: "rgba(34, 197, 94, 0.12)",
            border: "1px solid rgba(34, 197, 94, 0.3)",
            color: "#86efac",
            fontSize: "13px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <CheckCircle2 size={16} />
          <span>{notice}</span>
          <button
            onClick={() => setNotice("")}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "inherit", cursor: "pointer" }}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
