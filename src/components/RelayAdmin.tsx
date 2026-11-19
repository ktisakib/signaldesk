import { useEffect, useRef, useState, type SubmitEvent } from "react";
import Hls from "hls.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadRelayProfile } from "@/lib/relay";
import { authClient } from "@/lib/auth-client";
import { permits } from "../../server/permissions";
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  Edit,
  ExternalLink,
  HardDrive,
  Key,
  Laptop,
  Layers,
  Lock,
  LogOut,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Server,
  Shield,
  Trash2,
  Tv,
  Users,
  X,
} from "lucide-react";

export interface Policy {
  domain: string;
  enabled: boolean;
  maxReaders: number;
  egressMbps: number;
  ingestMbps: number;
  licenseRequired?: boolean;
}

export interface Channel {
  id: string;
  name: string;
  path: string;
  online: boolean;
  readers: number;
  policy: Policy;
}

export interface Platform {
  publicHost: string;
  srtPort: number;
  publicWebUrl: string;
  adminDomain: string;
}

export interface License {
  userId: string;
  keyPrefix: string;
  status: string;
  expiresAt: string;
  maxDevices: number;
  channelLimit: number;
}

export interface LicensedDevice {
  userId: string;
  deviceId: string;
  label: string;
  revoked: boolean;
  activatedAt: string;
}

export interface Person {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface Subscription {
  userId: string;
  plan: string;
  status: string;
  channelLimit: number;
  expiresAt: string | null;
}

export interface Overview {
  licenses: License[];
  devices: LicensedDevice[];
  actor: Person;
  clients: Person[];
  channels: Channel[];
  owners: { channelId: string; userId: string }[];
  subscriptions: Subscription[];
}

const defaultPolicy: Policy = {
  domain: "",
  enabled: true,
  maxReaders: 100,
  egressMbps: 100,
  ingestMbps: 10,
};

const initialPlatform: Platform = {
  publicHost: "103.140.205.192",
  srtPort: 8890,
  publicWebUrl: "http://103.140.205.192:18088",
  adminDomain: "",
};

async function relayRequest(
  path: string,
  token = "",
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      throw new Error(parsed.error || text);
    } catch {
      throw new Error(text || `Request failed (${response.status})`);
    }
  }
  return response.json();
}

export default function RelayAdmin({ accountMode = false }: { accountMode?: boolean }) {
  // Navigation tabs
  type TabKey = "overview" | "channels" | "licensing" | "subscriptions" | "users" | "network";
  const [activeTab, setActiveTab] = useState<TabKey>("overview");

  // Authentication & Sessions
  const session = authClient.useSession();
  const [token, setToken] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("signaldesk_admin_token") || "";
    }
    return "";
  });
  const [unlocked, setUnlocked] = useState(accountMode || !!token);

  // Data states
  const [channels, setChannels] = useState<Channel[]>([]);
  const [platform, setPlatform] = useState<Platform>(initialPlatform);
  const [overview, setOverview] = useState<Overview | null>(null);

  // Form & Interaction states
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Filter & Search states
  const [channelSearch, setChannelSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<"all" | "live" | "offline" | "disabled">("all");
  const [licenseSearch, setLicenseSearch] = useState("");
  const [licenseFilter, setLicenseFilter] = useState<"all" | "active" | "expired" | "revoked">("all");

  // Modals
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authTab, setAuthTab] = useState<"token" | "account">("token");
  const [showCreateChannelModal, setShowCreateChannelModal] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [secret, setSecret] = useState<{ id: string; publishingKey: string } | null>(null);
  const [showIssueLicenseModal, setShowIssueLicenseModal] = useState(false);
  const [editingLicenseClient, setEditingLicenseClient] = useState<string>("");
  const [showActivateDeviceModal, setShowActivateDeviceModal] = useState(false);
  const [showCreateUserModal, setShowCreateUserModal] = useState(false);
  const [showEditSubscriptionModal, setShowEditSubscriptionModal] = useState<Subscription | null>(null);
  const [issuedLicenseKey, setIssuedLicenseKey] = useState<{ key: string; email: string } | null>(null);

  // Form fields for Channel Creation/Edit
  const [formId, setFormId] = useState("");
  const [formName, setFormName] = useState("");
  const [formPolicy, setFormPolicy] = useState<Policy>({ ...defaultPolicy });

  // Video element for preview
  const videoRef = useRef<HTMLVideoElement>(null);

  const localAdmin =
    typeof location !== "undefined" &&
    (location.hostname === "localhost" ||
      location.hostname === "[::1]" ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname));

  const canAdmin =
    typeof location !== "undefined" &&
    (location.protocol === "https:" || localAdmin);

  const request = (path: string, authTok = token, method = "GET", body?: unknown) =>
    relayRequest(
      accountMode ? "/api/control/relay" + path : path,
      accountMode ? "" : authTok,
      method,
      body,
    );

  // Copy helper with feedback
  function copyToClipboard(text: string, label: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedText(label);
      setTimeout(() => setCopiedText(null), 2000);
    }
  }

  // Work wrapper
  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await loadChannels();
      if (session.data || accountMode) {
        await loadOverview();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Load Channels
  async function loadChannels() {
    try {
      const res = await request("/api/channels");
      if (res && Array.isArray(res.channels)) {
        setChannels(res.channels);
      }
    } catch (e) {
      console.warn("Failed loading channels:", e);
    }
  }

  // Load Platform settings
  async function loadPlatform() {
    try {
      const res = await request("/api/platform");
      if (res) setPlatform(res);
    } catch (e) {
      console.warn("Failed loading platform:", e);
    }
  }

  // Load Overview (Licenses, Users, Subscriptions, Devices)
  async function loadOverview() {
    try {
      const res = await fetch("/api/control/overview");
      if (res.ok) {
        const data = await res.json();
        setOverview(data);
      }
    } catch (e) {
      console.warn("Account overview not available:", e);
    }
  }

  // Initial load and polling
  useEffect(() => {
    let cancelled = false;

    async function initial() {
      try {
        await loadChannels();
        await loadPlatform();
        if (session.data || accountMode) {
          await loadOverview();
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }

    void initial();

    // Verify token if saved in sessionStorage
    if (token) {
      request("/api/admin/channels", token)
        .then(() => setUnlocked(true))
        .catch(() => {
          setUnlocked(false);
          setToken("");
          if (typeof window !== "undefined") {
            sessionStorage.removeItem("signaldesk_admin_token");
          }
        });
    }

    const timer = setInterval(() => {
      if (!cancelled) {
        void loadChannels();
        if (session.data || accountMode) {
          void loadOverview();
        }
      }
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session.data, accountMode]);

  // Video preview HLS attachment
  useEffect(() => {
    if (!selectedChannel || !videoRef.current) return;
    const player = videoRef.current;
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(selectedChannel.path);
      hls.attachMedia(player);
      return () => hls.destroy();
    }
    player.src = selectedChannel.path;
    return () => {
      player.removeAttribute("src");
      player.load();
    };
  }, [selectedChannel]);

  // Channel Save handler
  function saveChannel(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    void work(async () => {
      if (editingChannel) {
        await request(`/api/channels/${editingChannel.id}`, token, "PUT", {
          name: formName,
          policy: formPolicy,
        });
        setNotice("Channel settings saved successfully.");
        setEditingChannel(null);
      } else {
        const result = await request("/api/channels", token, "POST", {
          id: formId,
          name: formName,
          policy: formPolicy,
        });
        setSecret(result);
        setNotice(`Channel "${formName}" created. You can download the connection profile below.`);
        setShowCreateChannelModal(false);
      }
      setFormId("");
      setFormName("");
      setFormPolicy({ ...defaultPolicy });
    });
  }

  // Permissions calculation
  const actorRole = overview?.actor?.role || (session.data?.user as { role?: string })?.role;
  const isAdmin = permits(actorRole, "users") || unlocked;
  const isCrm = permits(actorRole, "subscriptions") || isAdmin;

  // Filtered Channels
  const filteredChannels = channels.filter((c) => {
    const matchesSearch =
      c.name.toLowerCase().includes(channelSearch.toLowerCase()) ||
      c.id.toLowerCase().includes(channelSearch.toLowerCase());
    if (!matchesSearch) return false;
    if (channelFilter === "live") return c.online && c.policy.enabled;
    if (channelFilter === "offline") return !c.online && c.policy.enabled;
    if (channelFilter === "disabled") return !c.policy.enabled;
    return true;
  });

  // Filtered Licenses
  const allLicenses = overview?.licenses || [];
  const filteredLicenses = allLicenses.filter((l) => {
    const client = overview?.clients?.find((c) => c.id === l.userId);
    const clientName = client?.name || client?.email || l.userId;
    const matchesSearch =
      clientName.toLowerCase().includes(licenseSearch.toLowerCase()) ||
      l.keyPrefix.toLowerCase().includes(licenseSearch.toLowerCase());
    if (!matchesSearch) return false;

    const isExpired = new Date(l.expiresAt) <= new Date();
    if (licenseFilter === "active") return l.status === "active" && !isExpired;
    if (licenseFilter === "expired") return isExpired;
    if (licenseFilter === "revoked") return l.status === "revoked";
    return true;
  });

  // Metric counts
  const liveCount = channels.filter((c) => c.online && c.policy.enabled).length;
  const totalReaders = channels.reduce((acc, c) => acc + (c.readers || 0), 0);
  const activeLicensesCount = allLicenses.filter(
    (l) => l.status === "active" && new Date(l.expiresAt) > new Date(),
  ).length;
  const totalDevicesCount = overview?.devices?.filter((d) => !d.revoked)?.length || 0;

  return (
    <div className="admin-shell">
      <div className="admin-container">
        {/* Top Header / Bar */}
        <header className="admin-topbar">
          <div className="admin-brand">
            <div className="admin-logo-mark">
              <Radio className="size-5" />
            </div>
            <div className="admin-title-group">
              <h1>
                <span>SignalDesk</span>
                <span className="text-[#516358]">/</span>
                <span className="text-[#b5edce] font-semibold">Relay & Operations</span>
              </h1>
              <p>Broadcast control, IPTV live streams & licensing administration</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Live Status indicator */}
            <div
              className={`pulse-badge ${liveCount > 0 ? "live" : channels.length > 0 ? "offline" : "disabled"}`}
            >
              <span className={`pulse-dot ${liveCount > 0 ? "bg-[#22c55e]" : "bg-[#94a3b8]"}`} />
              <span>
                {liveCount} on air / {channels.length} channels
              </span>
            </div>

            {/* Quick Actions */}
            {unlocked && (
              <Button
                size="sm"
                className="bg-[#23382c] text-[#b5edce] border border-[#335641] hover:bg-[#2e4c3a]"
                onClick={() => {
                  setFormId("");
                  setFormName("");
                  setFormPolicy({ ...defaultPolicy });
                  setShowCreateChannelModal(true);
                }}
              >
                <Plus className="size-3.5 mr-1" /> New Channel
              </Button>
            )}

            {isAdmin && overview && (
              <Button
                size="sm"
                variant="outline"
                className="border-[#2c3830] text-[#c9d7ce] hover:bg-[#1a231e]"
                onClick={() => {
                  setEditingLicenseClient(overview.clients?.[0]?.id || "");
                  setShowIssueLicenseModal(true);
                }}
              >
                <Key className="size-3.5 mr-1" /> Issue License
              </Button>
            )}

            {/* Admin Authentication Status */}
            {unlocked || session.data ? (
              <div className="flex items-center gap-2 bg-[#17201b] border border-[#27352d] px-3 py-1.5 rounded-lg text-xs">
                <Shield className="size-3.5 text-[#b5edce]" />
                <span className="text-[#c6d7cb] font-medium">
                  {session.data?.user?.name
                    ? `${session.data.user.name} (${actorRole || "admin"})`
                    : "Super Admin (Token)"}
                </span>
                <button
                  title="Lock administration"
                  className="ml-2 text-[#7f9185] hover:text-[#f87171] transition-colors"
                  onClick={() => {
                    if (session.data) {
                      void authClient.signOut();
                    }
                    setToken("");
                    setUnlocked(false);
                    if (typeof window !== "undefined") {
                      sessionStorage.removeItem("signaldesk_admin_token");
                    }
                    setNotice("Administration locked.");
                  }}
                >
                  <LogOut className="size-3.5" />
                </button>
              </div>
            ) : (
              <Button
                size="sm"
                className="bg-[#b5edce] text-[#0f1f16] hover:bg-[#9fe0bc] font-semibold"
                onClick={() => setShowAuthModal(true)}
              >
                <Lock className="size-3.5 mr-1.5" /> Admin Access
              </Button>
            )}
          </div>
        </header>

        {/* Global Notifications */}
        {error && (
          <div className="admin-toast-banner error">
            <AlertCircle className="size-4 shrink-0" />
            <span>{error}</span>
            <button className="ml-auto text-current opacity-70 hover:opacity-100" onClick={() => setError("")}>
              <X className="size-4" />
            </button>
          </div>
        )}
        {notice && (
          <div className="admin-toast-banner success">
            <CheckCircle2 className="size-4 shrink-0" />
            <span>{notice}</span>
            <button className="ml-auto text-current opacity-70 hover:opacity-100" onClick={() => setNotice("")}>
              <X className="size-4" />
            </button>
          </div>
        )}

        {/* Navigation Tabs */}
        <nav className="admin-nav" aria-label="Admin Navigation">
          <button
            className={`admin-nav-item ${activeTab === "overview" ? "active" : ""}`}
            onClick={() => setActiveTab("overview")}
          >
            <Activity className="size-4" />
            <span>Overview</span>
          </button>

          <button
            className={`admin-nav-item ${activeTab === "channels" ? "active" : ""}`}
            onClick={() => setActiveTab("channels")}
          >
            <Tv className="size-4" />
            <span>Channels & Playout</span>
            <span className="admin-nav-pill">{channels.length}</span>
          </button>

          <button
            className={`admin-nav-item ${activeTab === "licensing" ? "active" : ""}`}
            onClick={() => setActiveTab("licensing")}
          >
            <Key className="size-4" />
            <span>Licensing & Devices</span>
            {overview && <span className="admin-nav-pill">{allLicenses.length}</span>}
          </button>

          {(isCrm || (overview?.subscriptions && overview.subscriptions.length > 0)) && (
            <button
              className={`admin-nav-item ${activeTab === "subscriptions" ? "active" : ""}`}
              onClick={() => setActiveTab("subscriptions")}
            >
              <CreditCard className="size-4" />
              <span>Subscriptions</span>
              <span className="admin-nav-pill">{overview?.subscriptions?.length || 0}</span>
            </button>
          )}

          {isAdmin && overview && (
            <button
              className={`admin-nav-item ${activeTab === "users" ? "active" : ""}`}
              onClick={() => setActiveTab("users")}
            >
              <Users className="size-4" />
              <span>People & Team</span>
              <span className="admin-nav-pill">{overview?.clients?.length || 0}</span>
            </button>
          )}

          <button
            className={`admin-nav-item ${activeTab === "network" ? "active" : ""}`}
            onClick={() => setActiveTab("network")}
          >
            <Server className="size-4" />
            <span>Relay & Gateway</span>
          </button>
        </nav>

        {/* TAB 1: OVERVIEW */}
        {activeTab === "overview" && (
          <section aria-label="Dashboard Overview">
            {/* KPI Cards */}
            <div className="metrics-grid">
              <div className="metric-card">
                <div className="metric-header">
                  <span>TOTAL CHANNELS</span>
                  <div className="metric-icon-wrap">
                    <Tv className="size-4" />
                  </div>
                </div>
                <div className="metric-value">{channels.length}</div>
                <div className="metric-sub flex items-center gap-2">
                  <span className="text-[#4ade80] font-semibold">{liveCount} On Air</span>
                  <span>·</span>
                  <span>{channels.length - liveCount} Offline</span>
                </div>
              </div>

              <div className="metric-card">
                <div className="metric-header">
                  <span>CONCURRENT VIEWERS</span>
                  <div className="metric-icon-wrap">
                    <Users className="size-4" />
                  </div>
                </div>
                <div className="metric-value">{totalReaders}</div>
                <div className="metric-sub">Active HLS streaming sessions</div>
              </div>

              <div className="metric-card">
                <div className="metric-header">
                  <span>ACTIVE LICENSES</span>
                  <div className="metric-icon-wrap">
                    <Key className="size-4" />
                  </div>
                </div>
                <div className="metric-value">
                  {overview ? activeLicensesCount : "—"}
                </div>
                <div className="metric-sub">
                  {overview ? `${allLicenses.length} total client licenses` : "Sign in to inspect CRM licenses"}
                </div>
              </div>

              <div className="metric-card">
                <div className="metric-header">
                  <span>REGISTERED DEVICES</span>
                  <div className="metric-icon-wrap">
                    <Laptop className="size-4" />
                  </div>
                </div>
                <div className="metric-value">
                  {overview ? totalDevicesCount : "—"}
                </div>
                <div className="metric-sub">
                  {overview ? "Licensed broadcaster computers" : "Hardware installations"}
                </div>
              </div>

              <div className="metric-card">
                <div className="metric-header">
                  <span>PUBLIC GATEWAY</span>
                  <div className="metric-icon-wrap">
                    <HardDrive className="size-4" />
                  </div>
                </div>
                <div className="text-sm font-mono text-[#dbe8df] truncate" title={platform.publicHost}>
                  {platform.publicHost}
                </div>
                <div className="metric-sub flex items-center gap-1.5 font-mono">
                  <span>UDP {platform.srtPort}</span>
                  <span>·</span>
                  <span className="text-[#86efac]">Ready</span>
                </div>
              </div>
            </div>

            {/* Live Streams Monitor Table */}
            <div className="admin-table-card">
              <div className="admin-table-toolbar">
                <div className="flex items-center gap-2.5">
                  <Activity className="size-4 text-[#b5edce]" />
                  <h2 className="text-sm font-semibold text-[#f0f5f2]">Live Channels Monitor</h2>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      void loadChannels();
                      void loadOverview();
                    }}
                    className="border-[#2b3930] text-[#a1b4a7] hover:bg-[#1a231e]"
                  >
                    <RefreshCw className="size-3 mr-1" /> Refresh
                  </Button>
                </div>
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th>Status</th>
                      <th>Audience</th>
                      <th>Stream Endpoint</th>
                      <th>Max Bandwidth</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-10 text-[#7c8d82]">
                          No channels configured yet.{" "}
                          {unlocked ? (
                            <button
                              className="text-[#b5edce] underline hover:text-[#9fe0bc] ml-1"
                              onClick={() => setShowCreateChannelModal(true)}
                            >
                              Create your first channel
                            </button>
                          ) : (
                            <button
                              className="text-[#b5edce] underline hover:text-[#9fe0bc] ml-1"
                              onClick={() => setShowAuthModal(true)}
                            >
                              Unlock administration
                            </button>
                          )}
                        </td>
                      </tr>
                    ) : (
                      channels.map((channel) => (
                        <tr key={channel.id}>
                          <td>
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-[#1a241f] border border-[#2b3a30] flex items-center justify-center font-bold text-xs text-[#b5edce]">
                                {channel.name.slice(0, 2).toUpperCase()}
                              </div>
                              <div>
                                <div className="font-medium text-[#edf4ee]">{channel.name}</div>
                                <div className="text-xs text-[#7d8f83] font-mono">{channel.id}</div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span
                              className={`pulse-badge ${
                                !channel.policy.enabled
                                  ? "disabled"
                                  : channel.online
                                    ? "live"
                                    : "offline"
                              }`}
                            >
                              <span
                                className={`pulse-dot ${
                                  !channel.policy.enabled
                                    ? "bg-[#ef4444]"
                                    : channel.online
                                      ? "bg-[#22c55e]"
                                      : "bg-[#94a3b8]"
                                }`}
                              />
                              {!channel.policy.enabled
                                ? "DISABLED"
                                : channel.online
                                  ? "LIVE"
                                  : "OFFLINE"}
                            </span>
                          </td>
                          <td>
                            <div className="flex items-center gap-1.5 font-medium text-xs text-[#c5d5ca]">
                              <Users className="size-3.5 text-[#73867a]" />
                              <span>{channel.readers} HLS viewers</span>
                            </div>
                          </td>
                          <td>
                            <div className="flex items-center gap-1.5">
                              <span className="mono-chip" title={channel.path}>
                                {channel.path}
                              </span>
                              <button
                                title="Copy full IPTV M3U8 URL"
                                className="text-[#7d9084] hover:text-[#b5edce] p-1"
                                onClick={() => {
                                  const fullUrl = `${platform.publicWebUrl.replace(/\/$/, "")}${channel.path}`;
                                  copyToClipboard(fullUrl, `url-${channel.id}`);
                                }}
                              >
                                {copiedText === `url-${channel.id}` ? (
                                  <Check className="size-3.5 text-[#4ade80]" />
                                ) : (
                                  <Copy className="size-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                          <td>
                            <div className="text-xs text-[#8c9f93]">
                              {channel.policy.ingestMbps} Mbps in / {channel.policy.egressMbps} Mbps out
                            </div>
                          </td>
                          <td>
                            <div className="flex items-center gap-2">
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={!channel.online || !channel.policy.enabled}
                                className="border-[#2b3a30] text-[#c9d9cd] hover:bg-[#1f2b23] disabled:opacity-30"
                                onClick={() => setSelectedChannel(channel)}
                              >
                                <Play className="size-3 mr-1 text-[#4ade80]" /> Watch
                              </Button>
                              {unlocked && (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  className="text-[#96a99d] hover:text-[#edf4ee] hover:bg-[#1a241f]"
                                  onClick={() => {
                                    setEditingChannel(channel);
                                    setFormName(channel.name);
                                    setFormPolicy({ ...channel.policy });
                                  }}
                                >
                                  <Edit className="size-3.5" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Quick Action Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-[#141a17] border border-[#232c26] rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#8ba093] mb-2 uppercase tracking-wider">
                    <Tv className="size-4 text-[#b5edce]" />
                    <span>Playout & Ingest</span>
                  </div>
                  <h3 className="text-sm font-semibold text-[#edf4ee]">Broadcaster Connection Profiles</h3>
                  <p className="text-xs text-[#7e9084] mt-1.5 leading-relaxed">
                    Broadcasters use SignalDesk Studio to publish via SRT. Download private connection profiles for OBS or SignalDesk broadcaster laptops.
                  </p>
                </div>
                <div className="mt-4 pt-3 border-t border-[#1f2822]">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full border-[#2a372e] text-[#b5edce] hover:bg-[#1c2620]"
                    onClick={() => setActiveTab("channels")}
                  >
                    Manage Channel Ingest →
                  </Button>
                </div>
              </div>

              <div className="bg-[#141a17] border border-[#232c26] rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#8ba093] mb-2 uppercase tracking-wider">
                    <Key className="size-4 text-[#b5edce]" />
                    <span>Licensing Protection</span>
                  </div>
                  <h3 className="text-sm font-semibold text-[#edf4ee]">Broadcaster Device Enrolment</h3>
                  <p className="text-xs text-[#7e9084] mt-1.5 leading-relaxed">
                    Bound broadcaster devices require an authorized hardware installation ID and active license key before publishing to the relay.
                  </p>
                </div>
                <div className="mt-4 pt-3 border-t border-[#1f2822]">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full border-[#2a372e] text-[#b5edce] hover:bg-[#1c2620]"
                    onClick={() => setActiveTab("licensing")}
                  >
                    View Registered Devices →
                  </Button>
                </div>
              </div>

              <div className="bg-[#141a17] border border-[#232c26] rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#8ba093] mb-2 uppercase tracking-wider">
                    <Server className="size-4 text-[#b5edce]" />
                    <span>Network Gateway</span>
                  </div>
                  <h3 className="text-sm font-semibold text-[#edf4ee]">On-Demand TLS & Domains</h3>
                  <p className="text-xs text-[#7e9084] mt-1.5 leading-relaxed">
                    Point your DNS A records to {platform.publicHost}. The integrated Caddy gateway automatically issues HTTPS certificates.
                  </p>
                </div>
                <div className="mt-4 pt-3 border-t border-[#1f2822]">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full border-[#2a372e] text-[#b5edce] hover:bg-[#1c2620]"
                    onClick={() => setActiveTab("network")}
                  >
                    Network Settings →
                  </Button>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* TAB 2: CHANNELS & PLAYOUT */}
        {activeTab === "channels" && (
          <section aria-label="Channel Management">
            <div className="admin-table-card">
              <div className="admin-table-toolbar flex-wrap">
                <div className="flex items-center gap-3 flex-1 min-w-[260px]">
                  <div className="relative flex-1 max-w-sm">
                    <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#6e8074]" />
                    <Input
                      placeholder="Search channels by name or ID..."
                      value={channelSearch}
                      onChange={(e) => setChannelSearch(e.target.value)}
                      className="pl-8 h-8 text-xs bg-[#111713] border-[#253229]"
                    />
                    {channelSearch && (
                      <button
                        onClick={() => setChannelSearch("")}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6e8074] hover:text-[#dce7e0]"
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </div>

                  {/* Filter Pills */}
                  <div className="flex items-center gap-1 bg-[#111713] p-0.5 border border-[#253229] rounded-lg">
                    {(["all", "live", "offline", "disabled"] as const).map((filter) => (
                      <button
                        key={filter}
                        onClick={() => setChannelFilter(filter)}
                        className={`text-xs px-2.5 py-1 rounded-md font-medium capitalize transition-colors ${
                          channelFilter === filter
                            ? "bg-[#202e26] text-[#b5edce] font-semibold"
                            : "text-[#7a8d81] hover:text-[#cfddd3]"
                        }`}
                      >
                        {filter}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {unlocked ? (
                    <Button
                      size="sm"
                      className="bg-[#23382c] text-[#b5edce] border border-[#335641] hover:bg-[#2e4c3a]"
                      onClick={() => {
                        setFormId("");
                        setFormName("");
                        setFormPolicy({ ...defaultPolicy });
                        setShowCreateChannelModal(true);
                      }}
                    >
                      <Plus className="size-3.5 mr-1" /> Create Channel
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-[#2c3a30] text-[#a0b3a6] hover:bg-[#1a231e]"
                      onClick={() => setShowAuthModal(true)}
                    >
                      <Lock className="size-3.5 mr-1 text-[#b5edce]" /> Unlock Admin to Edit
                    </Button>
                  )}
                </div>
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th>Status</th>
                      <th>Viewers</th>
                      <th>IPTV Stream Path</th>
                      <th>Custom Domain</th>
                      <th>Ingest / Egress Limits</th>
                      <th className="text-right">Playout & Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredChannels.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-center py-12 text-[#7c8d82]">
                          No channels matching your filter.
                        </td>
                      </tr>
                    ) : (
                      filteredChannels.map((channel) => {
                        const directUrl = `${platform.publicWebUrl.replace(/\/$/, "")}${channel.path}`;
                        const domainUrl = channel.policy.domain
                          ? `https://${channel.policy.domain}/live/index.m3u8`
                          : null;

                        return (
                          <tr key={channel.id}>
                            <td>
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-[#18231d] border border-[#2b3b30] flex items-center justify-center font-bold text-xs text-[#b5edce]">
                                  {channel.name.slice(0, 2).toUpperCase()}
                                </div>
                                <div>
                                  <div className="font-medium text-[#edf4ee]">{channel.name}</div>
                                  <div className="text-xs text-[#7e9084] font-mono">{channel.id}</div>
                                </div>
                              </div>
                            </td>
                            <td>
                              <span
                                className={`pulse-badge ${
                                  !channel.policy.enabled
                                    ? "disabled"
                                    : channel.online
                                      ? "live"
                                      : "offline"
                                }`}
                              >
                                <span
                                  className={`pulse-dot ${
                                    !channel.policy.enabled
                                      ? "bg-[#ef4444]"
                                      : channel.online
                                        ? "bg-[#22c55e]"
                                        : "bg-[#94a3b8]"
                                  }`}
                                />
                                {!channel.policy.enabled
                                  ? "DISABLED"
                                  : channel.online
                                    ? "LIVE"
                                    : "OFFLINE"}
                              </span>
                            </td>
                            <td>
                              <div className="flex items-center gap-1.5 font-medium text-xs text-[#c6d7cb]">
                                <Users className="size-3.5 text-[#6c8073]" />
                                <span>{channel.readers} / {channel.policy.maxReaders}</span>
                              </div>
                            </td>
                            <td>
                              <div className="flex items-center gap-1.5">
                                <span className="mono-chip" title={directUrl}>
                                  {channel.path}
                                </span>
                                <button
                                  title="Copy stream URL"
                                  className="text-[#7c9083] hover:text-[#b5edce] p-1"
                                  onClick={() => copyToClipboard(directUrl, `url-${channel.id}`)}
                                >
                                  {copiedText === `url-${channel.id}` ? (
                                    <Check className="size-3.5 text-[#4ade80]" />
                                  ) : (
                                    <Copy className="size-3.5" />
                                  )}
                                </button>
                                <a
                                  href={directUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  title="Open M3U8 stream in new tab"
                                  className="text-[#7c9083] hover:text-[#b5edce] p-1"
                                >
                                  <ExternalLink className="size-3.5" />
                                </a>
                              </div>
                            </td>
                            <td>
                              {domainUrl ? (
                                <a
                                  href={domainUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs text-[#b5edce] hover:underline flex items-center gap-1"
                                >
                                  <span>{channel.policy.domain}</span>
                                  <ExternalLink className="size-3" />
                                </a>
                              ) : (
                                <span className="text-xs text-[#6e8074]">Default origin</span>
                              )}
                            </td>
                            <td>
                              <div className="text-xs text-[#8da194]">
                                <div>In: {channel.policy.ingestMbps} Mbps max</div>
                                <div>Out: {channel.policy.egressMbps} Mbps agg</div>
                              </div>
                            </td>
                            <td className="text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={!channel.online || !channel.policy.enabled}
                                  className="border-[#2b3a30] text-[#c9d9cd] hover:bg-[#1f2b23] disabled:opacity-30"
                                  onClick={() => setSelectedChannel(channel)}
                                >
                                  <Play className="size-3 mr-1 text-[#4ade80]" /> Watch
                                </Button>

                                {unlocked && (
                                  <>
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      title="Edit channel settings"
                                      className="text-[#8ba093] hover:text-[#edf4ee] hover:bg-[#1a241f]"
                                      onClick={() => {
                                        setEditingChannel(channel);
                                        setFormName(channel.name);
                                        setFormPolicy({ ...channel.policy });
                                      }}
                                    >
                                      <Edit className="size-3.5" />
                                    </Button>

                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      title="Rotate stream publishing key"
                                      className="text-[#8ba093] hover:text-[#b5edce] hover:bg-[#1a241f]"
                                      onClick={() => {
                                        if (
                                          window.confirm(
                                            `Rotate ${channel.name}'s publishing key? The active broadcaster will disconnect immediately.`,
                                          )
                                        ) {
                                          void work(async () => {
                                            const sec = await request(
                                              `/api/channels/${channel.id}/rotate`,
                                              token,
                                              "POST",
                                            );
                                            setSecret(sec);
                                            setNotice(`Key rotated for ${channel.name}.`);
                                          });
                                        }
                                      }}
                                    >
                                      <Key className="size-3.5" />
                                    </Button>

                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      title={channel.policy.enabled ? "Disable channel" : "Enable channel"}
                                      className="text-[#8ba093] hover:text-[#edf4ee] hover:bg-[#1a241f]"
                                      onClick={() =>
                                        void work(async () => {
                                          await request(
                                            `/api/channels/${channel.id}`,
                                            token,
                                            "PUT",
                                            {
                                              name: channel.name,
                                              policy: {
                                                ...channel.policy,
                                                enabled: !channel.policy.enabled,
                                              },
                                            },
                                          );
                                          setNotice(
                                            channel.policy.enabled
                                              ? `Channel "${channel.name}" disabled.`
                                              : `Channel "${channel.name}" enabled.`,
                                          );
                                        })
                                      }
                                    >
                                      <Radio
                                        className={`size-3.5 ${
                                          channel.policy.enabled ? "text-[#4ade80]" : "text-[#f87171]"
                                        }`}
                                      />
                                    </Button>

                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      title="Delete channel"
                                      className="text-[#8ba093] hover:text-[#f87171] hover:bg-[#2b1818]"
                                      onClick={() => {
                                        if (
                                          window.confirm(
                                            `Permanently delete ${channel.name} (${channel.id}) and disconnect broadcaster?`,
                                          )
                                        ) {
                                          void work(async () => {
                                            await request(`/api/channels/${channel.id}`, token, "DELETE");
                                            setNotice(`Channel ${channel.name} deleted.`);
                                            setSecret(null);
                                          });
                                        }
                                      }}
                                    >
                                      <Trash2 className="size-3.5" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* TAB 3: LICENSING & DEVICES */}
        {activeTab === "licensing" && (
          <section aria-label="Licensing & Devices">
            {/* Top summary row */}
            <div className="metrics-grid">
              <div className="metric-card">
                <div className="metric-header">
                  <span>TOTAL CLIENT LICENSES</span>
                  <div className="metric-icon-wrap">
                    <Key className="size-4" />
                  </div>
                </div>
                <div className="metric-value">{allLicenses.length}</div>
                <div className="metric-sub flex items-center gap-2">
                  <span className="text-[#4ade80] font-semibold">{activeLicensesCount} Active</span>
                  <span>·</span>
                  <span>{allLicenses.length - activeLicensesCount} Inactive/Expired</span>
                </div>
              </div>

              <div className="metric-card">
                <div className="metric-header">
                  <span>ENROLLED DEVICES</span>
                  <div className="metric-icon-wrap">
                    <Laptop className="size-4" />
                  </div>
                </div>
                <div className="metric-value">{totalDevicesCount}</div>
                <div className="metric-sub">Registered broadcaster hardware slots</div>
              </div>

              <div className="metric-card">
                <div className="metric-header">
                  <span>CHANNEL ALLOCATION</span>
                  <div className="metric-icon-wrap">
                    <Layers className="size-4" />
                  </div>
                </div>
                <div className="metric-value">
                  {allLicenses.reduce((acc, l) => acc + (l.channelLimit || 1), 0)}
                </div>
                <div className="metric-sub">Combined channel entitlement limit</div>
              </div>
            </div>

            {/* Client Licenses Table Card */}
            <div className="admin-table-card">
              <div className="admin-table-toolbar flex-wrap">
                <div className="flex items-center gap-3 flex-1 min-w-[260px]">
                  <div className="relative flex-1 max-w-sm">
                    <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#6e8074]" />
                    <Input
                      placeholder="Search licenses by client or key..."
                      value={licenseSearch}
                      onChange={(e) => setLicenseSearch(e.target.value)}
                      className="pl-8 h-8 text-xs bg-[#111713] border-[#253229]"
                    />
                  </div>

                  <div className="flex items-center gap-1 bg-[#111713] p-0.5 border border-[#253229] rounded-lg">
                    {(["all", "active", "expired", "revoked"] as const).map((filter) => (
                      <button
                        key={filter}
                        onClick={() => setLicenseFilter(filter)}
                        className={`text-xs px-2.5 py-1 rounded-md font-medium capitalize transition-colors ${
                          licenseFilter === filter
                            ? "bg-[#202e26] text-[#b5edce] font-semibold"
                            : "text-[#7a8d81] hover:text-[#cfddd3]"
                        }`}
                      >
                        {filter}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="bg-[#23382c] text-[#b5edce] border border-[#335641] hover:bg-[#2e4c3a]"
                    onClick={() => {
                      setEditingLicenseClient(overview?.clients?.[0]?.id || "");
                      setShowIssueLicenseModal(true);
                    }}
                  >
                    <Plus className="size-3.5 mr-1" /> Issue License
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    className="border-[#2b3930] text-[#c6d7cb] hover:bg-[#1a231e]"
                    onClick={() => setShowActivateDeviceModal(true)}
                  >
                    <Laptop className="size-3.5 mr-1" /> Activate Device
                  </Button>
                </div>
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Client / Account</th>
                      <th>Key Prefix</th>
                      <th>Status</th>
                      <th>Expiration</th>
                      <th>Broadcaster Devices</th>
                      <th>Channel Allowance</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLicenses.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-center py-12 text-[#7c8d82]">
                          {overview ? (
                            <span>No licenses matching filter.</span>
                          ) : (
                            <div className="max-w-md mx-auto space-y-2">
                              <p className="text-[#a4b6aa] font-medium">Account service not connected or signed out.</p>
                              <p className="text-xs text-[#708176]">
                                Sign in with your administrator account to manage database-backed licenses, subscriptions, and device activations.
                              </p>
                              <Button
                                size="sm"
                                className="mt-2 bg-[#b5edce] text-[#0d1e15] font-semibold"
                                onClick={() => {
                                  setAuthTab("account");
                                  setShowAuthModal(true);
                                }}
                              >
                                Sign In to Accounts
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : (
                      filteredLicenses.map((lic) => {
                        const client = overview?.clients?.find((c) => c.id === lic.userId);
                        const isExpired = new Date(lic.expiresAt) <= new Date();
                        const deviceCount =
                          overview?.devices?.filter((d) => d.userId === lic.userId && !d.revoked)?.length || 0;

                        return (
                          <tr key={lic.userId}>
                            <td>
                              <div className="font-medium text-[#edf4ee]">
                                {client?.name || (lic.userId === overview?.actor?.id ? "Your account" : "Client Account")}
                              </div>
                              <div className="text-xs text-[#7c8f82]">{client?.email || lic.userId}</div>
                            </td>
                            <td>
                              <div className="flex items-center gap-1.5 font-mono text-xs">
                                <span className="mono-chip">{lic.keyPrefix}…</span>
                                <button
                                  title="Copy key prefix"
                                  className="text-[#7c9083] hover:text-[#b5edce] p-1"
                                  onClick={() => copyToClipboard(lic.keyPrefix, `lic-${lic.userId}`)}
                                >
                                  {copiedText === `lic-${lic.userId}` ? (
                                    <Check className="size-3 text-[#4ade80]" />
                                  ) : (
                                    <Copy className="size-3" />
                                  )}
                                </button>
                              </div>
                            </td>
                            <td>
                              <span
                                className={`pulse-badge ${
                                  lic.status !== "active"
                                    ? "disabled"
                                    : isExpired
                                      ? "disabled"
                                      : "live"
                                }`}
                              >
                                {isExpired ? "EXPIRED" : lic.status.toUpperCase()}
                              </span>
                            </td>
                            <td>
                              <div className="text-xs text-[#dce7df]">
                                {new Date(lic.expiresAt).toLocaleDateString()} {new Date(lic.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </div>
                              <div className="text-[11px] text-[#788a7e] flex items-center gap-1 mt-0.5">
                                <Clock className="size-3" />
                                {isExpired ? (
                                  <span className="text-[#f87171]">Expired</span>
                                ) : (
                                  <span>
                                    {Math.ceil((new Date(lic.expiresAt).getTime() - Date.now()) / 86400000)} days left
                                  </span>
                                )}
                              </div>
                            </td>
                            <td>
                              <div className="text-xs text-[#c6d7cb] font-medium">
                                {deviceCount} / {lic.maxDevices} devices
                              </div>
                              <div className="w-24 bg-[#1e2722] rounded-full h-1.5 mt-1 overflow-hidden">
                                <div
                                  className={`h-full ${
                                    deviceCount >= lic.maxDevices ? "bg-[#f87171]" : "bg-[#4ade80]"
                                  }`}
                                  style={{
                                    width: `${Math.min(100, (deviceCount / Math.max(1, lic.maxDevices)) * 100)}%`,
                                  }}
                                />
                              </div>
                            </td>
                            <td>
                              <span className="text-xs text-[#c6d7cb] font-semibold">{lic.channelLimit} channels</span>
                            </td>
                            <td className="text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <Button
                                  size="xs"
                                  variant="outline"
                                  className="border-[#2b3930] text-[#c9d7ce] hover:bg-[#1a231e]"
                                  onClick={() => {
                                    setEditingLicenseClient(lic.userId);
                                    setShowIssueLicenseModal(true);
                                  }}
                                >
                                  Edit / Renew
                                </Button>

                                <Button
                                  size="xs"
                                  variant="ghost"
                                  title="Rotate license key and revoke devices"
                                  className="text-[#8ba093] hover:text-[#f87171] hover:bg-[#2b1818]"
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        "Replace this license key? All active device activations for this client will be revoked immediately.",
                                      )
                                    ) {
                                      void work(async () => {
                                        const res = await fetch("/api/control/license-rotate", {
                                          method: "POST",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ userId: lic.userId }),
                                        });
                                        const data = await res.json();
                                        if (!res.ok) throw new Error(data.error || "Rotate failed");
                                        if (data.key) {
                                          setIssuedLicenseKey({
                                            key: data.key,
                                            email: client?.email || lic.userId,
                                          });
                                        }
                                        setNotice("License key rotated. All previous devices revoked.");
                                      });
                                    }
                                  }}
                                >
                                  <RefreshCw className="size-3.5" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Broadcaster Devices Table */}
            <div className="admin-table-card mt-6">
              <div className="admin-table-toolbar">
                <div className="flex items-center gap-2.5">
                  <Laptop className="size-4 text-[#b5edce]" />
                  <h3 className="text-sm font-semibold text-[#f0f5f2]">Registered Broadcaster Devices</h3>
                </div>
                <div className="text-xs text-[#788a7e]">
                  Hardware installations authorized to stream
                </div>
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Device Label</th>
                      <th>Hardware Installation ID</th>
                      <th>Account / Client</th>
                      <th>Status</th>
                      <th>Activated At</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!overview || !overview.devices || overview.devices.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-10 text-[#7c8d82]">
                          No broadcaster devices registered yet. Broadcasters register via the desktop app or the device activation tool.
                        </td>
                      </tr>
                    ) : (
                      overview.devices.map((device) => {
                        const client = overview.clients?.find((c) => c.id === device.userId);
                        return (
                          <tr key={device.userId + device.deviceId}>
                            <td>
                              <div className="flex items-center gap-2">
                                <Laptop className="size-3.5 text-[#738578]" />
                                <span className="font-medium text-[#edf4ee]">{device.label}</span>
                              </div>
                            </td>
                            <td>
                              <div className="flex items-center gap-1.5 font-mono text-xs">
                                <span className="mono-chip">{device.deviceId}</span>
                                <button
                                  title="Copy device ID"
                                  className="text-[#7c9083] hover:text-[#b5edce] p-1"
                                  onClick={() => copyToClipboard(device.deviceId, `dev-${device.deviceId}`)}
                                >
                                  {copiedText === `dev-${device.deviceId}` ? (
                                    <Check className="size-3 text-[#4ade80]" />
                                  ) : (
                                    <Copy className="size-3" />
                                  )}
                                </button>
                              </div>
                            </td>
                            <td>
                              <div className="text-xs text-[#dbe6de]">{client?.name || device.userId}</div>
                            </td>
                            <td>
                              <span className={`pulse-badge ${device.revoked ? "offline" : "live"}`}>
                                {device.revoked ? "RELEASED" : "REGISTERED"}
                              </span>
                            </td>
                            <td>
                              <div className="text-xs text-[#7b8d81]">
                                {new Date(device.activatedAt).toLocaleDateString()} {new Date(device.activatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </div>
                            </td>
                            <td className="text-right">
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={busy || device.revoked}
                                className="border-[#2b3a30] text-[#c9d9cd] hover:bg-[#2b1818] hover:text-[#f87171] disabled:opacity-30"
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Release device "${device.label}"? This frees up a device slot and disconnects this computer.`,
                                    )
                                  ) {
                                    void work(async () => {
                                      const res = await fetch("/api/control/license-device-revoke", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                          userId: device.userId,
                                          deviceId: device.deviceId,
                                        }),
                                      });
                                      if (!res.ok) {
                                        const err = await res.json();
                                        throw new Error(err.error || "Device release failed");
                                      }
                                      setNotice(`Device "${device.label}" released.`);
                                    });
                                  }
                                }}
                              >
                                Release Device
                              </Button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* TAB 4: SUBSCRIPTIONS & CRM */}
        {activeTab === "subscriptions" && overview && (
          <section aria-label="Subscriptions & CRM">
            <div className="admin-table-card">
              <div className="admin-table-toolbar">
                <div className="flex items-center gap-2.5">
                  <CreditCard className="size-4 text-[#b5edce]" />
                  <h3 className="text-sm font-semibold text-[#f0f5f2]">Customer Subscriptions & Entitlements</h3>
                </div>
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Client / Account</th>
                      <th>Plan Tier</th>
                      <th>Status</th>
                      <th>Channel Allowance</th>
                      <th>Expiration Date</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.subscriptions.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-10 text-[#7c8d82]">
                          No client subscriptions recorded.
                        </td>
                      </tr>
                    ) : (
                      overview.subscriptions.map((sub) => {
                        const client = overview.clients?.find((c) => c.id === sub.userId);
                        return (
                          <tr key={sub.userId}>
                            <td>
                              <div className="font-medium text-[#edf4ee]">{client?.name || sub.userId}</div>
                              <div className="text-xs text-[#788a7e]">{client?.email}</div>
                            </td>
                            <td>
                              <span className="text-xs font-semibold px-2 py-0.5 rounded bg-[#1e2722] text-[#b5edce] border border-[#2b3930]">
                                {sub.plan}
                              </span>
                            </td>
                            <td>
                              <span className={`pulse-badge ${sub.status === "active" ? "live" : "disabled"}`}>
                                {sub.status.toUpperCase()}
                              </span>
                            </td>
                            <td>
                              <span className="text-xs text-[#dbe6de] font-medium">{sub.channelLimit} channels</span>
                            </td>
                            <td>
                              <div className="text-xs text-[#788a7e]">
                                {sub.expiresAt ? new Date(sub.expiresAt).toLocaleDateString() : "No expiry (perpetual)"}
                              </div>
                            </td>
                            <td className="text-right">
                              {isCrm && (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  className="border-[#2b3a30] text-[#c9d9cd] hover:bg-[#1a231e]"
                                  onClick={() => setShowEditSubscriptionModal(sub)}
                                >
                                  Edit Plan
                                </Button>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* TAB 5: PEOPLE & TEAM ACCESS */}
        {activeTab === "users" && overview && (
          <section aria-label="People & Team">
            <div className="admin-table-card">
              <div className="admin-table-toolbar">
                <div className="flex items-center gap-2.5">
                  <Users className="size-4 text-[#b5edce]" />
                  <h3 className="text-sm font-semibold text-[#f0f5f2]">Platform Users & Permissions</h3>
                </div>
                {isAdmin && (
                  <Button
                    size="sm"
                    className="bg-[#23382c] text-[#b5edce] border border-[#335641] hover:bg-[#2e4c3a]"
                    onClick={() => setShowCreateUserModal(true)}
                  >
                    <Plus className="size-3.5 mr-1" /> Add Account
                  </Button>
                )}
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>User Name</th>
                      <th>Email Address</th>
                      <th>Assigned Role</th>
                      <th>Channel Access</th>
                      <th className="text-right">Manage Access</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.clients.map((person) => {
                      const ownedChannels = overview.owners
                        .filter((o) => o.userId === person.id)
                        .map((o) => overview.channels.find((c) => c.id === o.channelId)?.name || o.channelId);

                      return (
                        <tr key={person.id}>
                          <td>
                            <div className="font-medium text-[#edf4ee]">{person.name}</div>
                          </td>
                          <td>
                            <span className="text-xs text-[#7b8e81] font-mono">{person.email}</span>
                          </td>
                          <td>
                            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-[#1c2520] text-[#b5edce] border border-[#2b3a30] uppercase">
                              {person.role || "user"}
                            </span>
                          </td>
                          <td>
                            <div className="text-xs text-[#a0b3a5]">
                              {ownedChannels.length > 0
                                ? ownedChannels.join(", ")
                                : "No explicit channels"}
                            </div>
                          </td>
                          <td className="text-right">
                            {isAdmin && (
                              <div className="flex items-center justify-end gap-2">
                                <select
                                  defaultValue={person.role || "user"}
                                  className="text-xs bg-[#111713] text-[#dce7df] border border-[#253229] rounded px-2 py-1"
                                  onChange={(e) => {
                                    const newRole = e.target.value as "user";
                                    void work(async () => {
                                      const res = await authClient.admin.setRole({
                                        userId: person.id,
                                        role: newRole,
                                      });
                                      if (res.error) throw new Error(res.error.message);
                                      setNotice(`Role updated for ${person.name}.`);
                                    });
                                  }}
                                >
                                  {["user", "support", "crm", "admin"].map((r) => (
                                    <option key={r} value={r}>
                                      {r}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* TAB 6: RELAY & NETWORK SETTINGS */}
        {activeTab === "network" && (
          <section aria-label="Relay Settings" className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-[#141a17] border border-[#232c26] rounded-xl p-6">
              <div className="flex items-center gap-2.5 pb-4 mb-5 border-b border-[#212a24]">
                <Server className="size-4 text-[#b5edce]" />
                <h3 className="text-sm font-semibold text-[#f0f5f2]">Public Relay Endpoints</h3>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void work(async () => {
                    await request("/api/platform", token, "PUT", platform);
                    setNotice("Public gateway settings saved successfully.");
                  });
                }}
              >
                <div className="form-group">
                  <label htmlFor="pub-host">Public Publishing IP or Hostname</label>
                  <Input
                    id="pub-host"
                    required
                    value={platform.publicHost}
                    onChange={(e) => setPlatform({ ...platform, publicHost: e.target.value })}
                    className="bg-[#111713] border-[#253229]"
                  />
                  <span className="form-hint">Used in broadcaster connection profiles for SRT stream publishing.</span>
                </div>

                <div className="form-group">
                  <label htmlFor="srt-port">Public SRT UDP Port</label>
                  <Input
                    id="srt-port"
                    type="number"
                    min={1}
                    max={65535}
                    required
                    value={platform.srtPort}
                    onChange={(e) => setPlatform({ ...platform, srtPort: Number(e.target.value) })}
                    className="bg-[#111713] border-[#253229]"
                  />
                  <span className="form-hint">UDP port must be forwarded on your external firewall / cloud security group.</span>
                </div>

                <div className="form-group">
                  <label htmlFor="pub-web">Public Website Origin URL</label>
                  <Input
                    id="pub-web"
                    type="url"
                    required
                    value={platform.publicWebUrl}
                    onChange={(e) => setPlatform({ ...platform, publicWebUrl: e.target.value })}
                    className="bg-[#111713] border-[#253229]"
                  />
                  <span className="form-hint">Base URL used to construct viewer IPTV and HLS stream playback links.</span>
                </div>

                <div className="form-group">
                  <label htmlFor="admin-dom">Administration Domain</label>
                  <Input
                    id="admin-dom"
                    placeholder="tv.example.com"
                    value={platform.adminDomain}
                    onChange={(e) =>
                      setPlatform({
                        ...platform,
                        adminDomain: e.target.value.toLowerCase().trim(),
                        ...(e.target.value.trim()
                          ? { publicWebUrl: `https://${e.target.value.toLowerCase().trim()}` }
                          : {}),
                      })
                    }
                    className="bg-[#111713] border-[#253229]"
                  />
                  <span className="form-hint">Points to this relay console. Automatically provisions HTTPS certificates.</span>
                </div>

                <div className="pt-2">
                  <Button type="submit" disabled={busy || !unlocked} className="bg-[#b5edce] text-[#0f1f16] font-semibold">
                    Save Gateway Settings
                  </Button>
                </div>
              </form>
            </div>

            <div className="bg-[#141a17] border border-[#232c26] rounded-xl p-6 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2.5 pb-4 mb-4 border-b border-[#212a24]">
                  <Shield className="size-4 text-[#b5edce]" />
                  <h3 className="text-sm font-semibold text-[#f0f5f2]">DNS & SSL Certificate Architecture</h3>
                </div>

                <div className="space-y-4 text-xs text-[#a0b3a5] leading-relaxed">
                  <p>
                    <strong className="text-[#edf4ee]">1. DNS A-Record Configuration:</strong>
                    <br />
                    Add an <code className="text-[#b5edce]">A</code> record in your DNS provider pointing your domain (e.g. <code className="text-[#b5edce]">tv.pressmos.com</code>) to the public host IP <strong className="text-[#edf4ee]">{platform.publicHost}</strong>.
                  </p>

                  <p>
                    <strong className="text-[#edf4ee]">2. On-Demand TLS (Caddy):</strong>
                    <br />
                    The public Docker gateway automatically fetches and renews Let&apos;s Encrypt / ZeroSSL certificates as soon as HTTP requests arrive on ports 80 and 443.
                  </p>

                  <p>
                    <strong className="text-[#edf4ee]">3. Ingest Bandwidth Policy:</strong>
                    <br />
                    Publishers exceeding their measured bitrate limit for 5 consecutive seconds are automatically disconnected to prevent server saturation.
                  </p>
                </div>
              </div>

              <div className="p-4 bg-[#111613] border border-[#202923] rounded-lg mt-6">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#dce8df] mb-1">
                  <Activity className="size-3.5 text-[#4ade80]" />
                  <span>Gateway Healthcheck</span>
                </div>
                <p className="text-[11px] text-[#788a7e]">
                  MediaMTX engine and Caddy reverse proxy are healthy. Public administration requires HTTPS when outside local LAN.
                </p>
              </div>
            </div>
          </section>
        )}

        {/* MODAL 1: AUTHENTICATION / UNLOCK ADMIN */}
        {showAuthModal && (
          <div className="admin-dialog-overlay" onClick={() => setShowAuthModal(false)}>
            <div className="admin-dialog-content" onClick={(e) => e.stopPropagation()}>
              <div className="admin-dialog-header">
                <h3>Admin Authentication</h3>
                <button
                  className="text-[#7d9084] hover:text-[#edf4ee]"
                  onClick={() => setShowAuthModal(false)}
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="admin-dialog-body">
                {/* Tabs */}
                <div className="flex border-b border-[#232c26] mb-5">
                  <button
                    className={`pb-2.5 px-4 text-xs font-semibold border-b-2 transition-colors ${
                      authTab === "token"
                        ? "border-[#b5edce] text-[#b5edce]"
                        : "border-transparent text-[#7d9084] hover:text-[#dce7df]"
                    }`}
                    onClick={() => setAuthTab("token")}
                  >
                    Relay Administrator Token
                  </button>
                  <button
                    className={`pb-2.5 px-4 text-xs font-semibold border-b-2 transition-colors ${
                      authTab === "account"
                        ? "border-[#b5edce] text-[#b5edce]"
                        : "border-transparent text-[#7d9084] hover:text-[#dce7df]"
                    }`}
                    onClick={() => setAuthTab("account")}
                  >
                    Team & Client Account
                  </button>
                </div>

                {authTab === "token" ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void work(async () => {
                        await request("/api/admin/channels", token);
                        setUnlocked(true);
                        if (typeof window !== "undefined") {
                          sessionStorage.setItem("signaldesk_admin_token", token);
                        }
                        setNotice("Super administration unlocked.");
                        setShowAuthModal(false);
                      });
                    }}
                  >
                    {!canAdmin && (
                      <p className="text-xs text-[#fca5a5] bg-[#2d1818] border border-[#4a2222] p-2.5 rounded-lg mb-4">
                        Open the relay’s private LAN address or configure HTTPS for public administration.
                      </p>
                    )}
                    <p className="text-xs text-[#8da194] mb-4">
                      Enter the relay administrator token configured on your server to manage channels and stream limits.
                    </p>

                    <div className="form-group">
                      <label htmlFor="token-input">Administrator Token</label>
                      <Input
                        id="token-input"
                        type="password"
                        required
                        disabled={!canAdmin}
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="Enter RELAY_ADMIN_TOKEN..."
                        className="bg-[#111713] border-[#253229]"
                      />
                    </div>

                    <div className="flex justify-end gap-2 mt-6">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setShowAuthModal(false)}
                        className="border-[#2c3a30]"
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        disabled={busy || !canAdmin}
                        className="bg-[#b5edce] text-[#0f1f16] font-semibold"
                      >
                        Unlock Super Admin
                      </Button>
                    </div>
                  </form>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const formEl = e.currentTarget;
                      const formData = new FormData(formEl);
                      const email = String(formData.get("email") || "");
                      const password = String(formData.get("password") || "");

                      void work(async () => {
                        const r = await authClient.signIn.email({ email, password });
                        if (r.error) throw new Error(r.error.message);
                        await loadOverview();
                        setNotice("Signed in successfully.");
                        setShowAuthModal(false);
                      });
                    }}
                  >
                    <p className="text-xs text-[#8da194] mb-4">
                      Sign in with your team credentials to manage licenses, CRM subscriptions, and broadcaster devices.
                    </p>

                    <div className="form-group">
                      <label>Email Address</label>
                      <Input
                        name="email"
                        type="email"
                        required
                        placeholder="admin@example.com"
                        className="bg-[#111713] border-[#253229]"
                      />
                    </div>

                    <div className="form-group">
                      <label>Password</label>
                      <Input
                        name="password"
                        type="password"
                        required
                        placeholder="••••••••••••"
                        className="bg-[#111713] border-[#253229]"
                      />
                    </div>

                    <div className="flex justify-end gap-2 mt-6">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setShowAuthModal(false)}
                        className="border-[#2c3a30]"
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        disabled={busy}
                        className="bg-[#b5edce] text-[#0f1f16] font-semibold"
                      >
                        Sign In
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          </div>
        )}

        {/* MODAL 2: LIVE PREVIEW PLAYER */}
        {selectedChannel && (
          <div className="admin-dialog-overlay" onClick={() => setSelectedChannel(null)}>
            <div className="admin-dialog-content max-w-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="admin-dialog-header">
                <div className="flex items-center gap-2">
                  <Play className="size-4 text-[#4ade80]" />
                  <h3>Live Preview: {selectedChannel.name}</h3>
                </div>
                <button
                  className="text-[#7d9084] hover:text-[#edf4ee]"
                  onClick={() => setSelectedChannel(null)}
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="admin-dialog-body p-0">
                <div className="relative bg-black aspect-video flex items-center justify-center">
                  <video
                    ref={videoRef}
                    controls
                    autoPlay
                    playsInline
                    className="w-full h-full max-h-[460px] object-contain"
                  />
                </div>

                <div className="p-4 bg-[#111613] border-t border-[#232c26] flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 font-mono text-[#a0b4a7]">
                    <span className="mono-chip">{selectedChannel.path}</span>
                    <button
                      className="text-[#7d9084] hover:text-[#b5edce] p-1"
                      onClick={() => {
                        const full = `${platform.publicWebUrl.replace(/\/$/, "")}${selectedChannel.path}`;
                        copyToClipboard(full, "preview-url");
                      }}
                    >
                      {copiedText === "preview-url" ? (
                        <Check className="size-3 text-[#4ade80]" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                  </div>
                  <div className="text-[#8ba093]">
                    {selectedChannel.readers} viewers active
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* MODAL 3: CREATE / EDIT CHANNEL */}
        {(showCreateChannelModal || editingChannel) && (
          <div
            className="admin-dialog-overlay"
            onClick={() => {
              setShowCreateChannelModal(false);
              setEditingChannel(null);
            }}
          >
            <div className="admin-dialog-content" onClick={(e) => e.stopPropagation()}>
              <div className="admin-dialog-header">
                <h3>{editingChannel ? `Edit Channel: ${editingChannel.name}` : "Create New Channel"}</h3>
                <button
                  className="text-[#7d9084] hover:text-[#edf4ee]"
                  onClick={() => {
                    setShowCreateChannelModal(false);
                    setEditingChannel(null);
                  }}
                >
                  <X className="size-4" />
                </button>
              </div>

              <form onSubmit={saveChannel}>
                <div className="admin-dialog-body">
                  {!editingChannel && (
                    <div className="form-group">
                      <label htmlFor="ch-id">Channel ID (slug)</label>
                      <Input
                        id="ch-id"
                        required
                        pattern="[a-z0-9-]{1,64}"
                        placeholder="e.g. newsroom-main"
                        value={formId}
                        onChange={(e) => setFormId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                        className="bg-[#111713] border-[#253229]"
                      />
                      <span className="form-hint">Unique lowercase alphanumeric identifier (used in URL and SRT stream name).</span>
                    </div>
                  )}

                  <div className="form-group">
                    <label htmlFor="ch-name">Channel Display Name</label>
                    <Input
                      id="ch-name"
                      required
                      maxLength={100}
                      placeholder="e.g. Channel 1 Newsroom HD"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      className="bg-[#111713] border-[#253229]"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="ch-domain">Custom Domain (Optional)</label>
                    <Input
                      id="ch-domain"
                      placeholder="e.g. news.example.com"
                      value={formPolicy.domain}
                      onChange={(e) =>
                        setFormPolicy({ ...formPolicy, domain: e.target.value.toLowerCase().trim() })
                      }
                      className="bg-[#111713] border-[#253229]"
                    />
                    <span className="form-hint">
                      Point domain DNS to {platform.publicHost}. Stream URL will be https://your-domain/live/index.m3u8.
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="form-group">
                      <label htmlFor="ch-readers">Max Simultaneous Viewers</label>
                      <Input
                        id="ch-readers"
                        type="number"
                        min={1}
                        max={10000}
                        required
                        value={formPolicy.maxReaders}
                        onChange={(e) =>
                          setFormPolicy({ ...formPolicy, maxReaders: Number(e.target.value) })
                        }
                        className="bg-[#111713] border-[#253229]"
                      />
                    </div>

                    <div className="form-group">
                      <label htmlFor="ch-ingest">Max Ingest Bitrate (Mbps)</label>
                      <Input
                        id="ch-ingest"
                        type="number"
                        min={1}
                        max={1000}
                        required
                        value={formPolicy.ingestMbps}
                        onChange={(e) =>
                          setFormPolicy({ ...formPolicy, ingestMbps: Number(e.target.value) })
                        }
                        className="bg-[#111713] border-[#253229]"
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label htmlFor="ch-egress">Aggregate Egress Limit (Mbps)</label>
                    <Input
                      id="ch-egress"
                      type="number"
                      min={1}
                      max={10000}
                      required
                      value={formPolicy.egressMbps}
                      onChange={(e) =>
                        setFormPolicy({ ...formPolicy, egressMbps: Number(e.target.value) })
                      }
                      className="bg-[#111713] border-[#253229]"
                    />
                  </div>

                  <div className="flex items-center gap-2 pt-2">
                    <input
                      type="checkbox"
                      id="ch-enabled"
                      checked={formPolicy.enabled}
                      onChange={(e) => setFormPolicy({ ...formPolicy, enabled: e.target.checked })}
                      className="rounded border-[#253229] bg-[#111713]"
                    />
                    <label htmlFor="ch-enabled" className="text-xs font-medium cursor-pointer">
                      Channel Playout Enabled
                    </label>
                  </div>
                </div>

                <div className="admin-dialog-footer">
                  <Button
                    type="button"
                    variant="outline"
                    className="border-[#2c3a30]"
                    onClick={() => {
                      setShowCreateChannelModal(false);
                      setEditingChannel(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy} className="bg-[#b5edce] text-[#0f1f16] font-semibold">
                    {editingChannel ? "Save Changes" : "Create Channel"}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* MODAL 4: PUBLISHING KEY / PROFILE DOWNLOAD */}
        {secret && (
          <div className="admin-dialog-overlay" onClick={() => setSecret(null)}>
            <div className="admin-dialog-content" onClick={(e) => e.stopPropagation()}>
              <div className="admin-dialog-header">
                <div className="flex items-center gap-2">
                  <Key className="size-4 text-[#b5edce]" />
                  <h3>Broadcaster Connection Credentials</h3>
                </div>
                <button className="text-[#7d9084] hover:text-[#edf4ee]" onClick={() => setSecret(null)}>
                  <X className="size-4" />
                </button>
              </div>

              <div className="admin-dialog-body space-y-4">
                <p className="text-xs text-[#a0b4a7] leading-relaxed">
                  Download this private connection profile for the broadcaster. The SRT stream key is displayed once after creation or key rotation.
                </p>

                <div className="form-group">
                  <label>SRT Publishing Passphrase / Key</label>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      type="password"
                      value={secret.publishingKey}
                      className="bg-[#111713] border-[#253229] font-mono"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-[#2b3a30]"
                      onClick={() => copyToClipboard(secret.publishingKey, "stream-key")}
                    >
                      {copiedText === "stream-key" ? <Check className="size-3.5 text-[#4ade80]" /> : <Copy className="size-3.5" />}
                    </Button>
                  </div>
                </div>

                <div className="p-3 bg-[#111613] border border-[#212b25] rounded-lg text-xs space-y-1 font-mono text-[#8ba093]">
                  <div>Channel ID: <span className="text-[#edf4ee]">{secret.id}</span></div>
                  <div>Publishing Host: <span className="text-[#edf4ee]">{platform.publicHost}</span></div>
                  <div>SRT Port: <span className="text-[#edf4ee]">{platform.srtPort}</span> (UDP)</div>
                </div>

                <Button
                  className="w-full bg-[#b5edce] text-[#0f1f16] font-semibold"
                  onClick={() => {
                    downloadRelayProfile({
                      format: "signaldesk-connection-v1",
                      channelName: secret.id,
                      host: platform.publicHost,
                      port: platform.srtPort,
                      viewerUrl: platform.publicWebUrl.replace(/\/$/, ""),
                      streamKey: secret.publishingKey,
                    });
                  }}
                >
                  Download .signaldesk-connection Profile
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* MODAL 5: ISSUE OR RENEW LICENSE */}
        {showIssueLicenseModal && overview && (
          <div className="admin-dialog-overlay" onClick={() => setShowIssueLicenseModal(false)}>
            <div className="admin-dialog-content" onClick={(e) => e.stopPropagation()}>
              <div className="admin-dialog-header">
                <h3>Issue / Renew Client License</h3>
                <button
                  className="text-[#7d9084] hover:text-[#edf4ee]"
                  onClick={() => setShowIssueLicenseModal(false)}
                >
                  <X className="size-4" />
                </button>
              </div>

              {(() => {
                const currentLic = overview.licenses.find((l) => l.userId === editingLicenseClient);
                return (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const formEl = e.currentTarget;
                      const f = new FormData(formEl);
                      const isNew = !currentLic;

                      void work(async () => {
                        const path = isNew ? "license-create" : "license-update";
                        const res = await fetch("/api/control/" + path, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            userId: editingLicenseClient,
                            status: f.get("status"),
                            expiresAt: new Date(String(f.get("expiresAt"))).toISOString(),
                            maxDevices: Number(f.get("maxDevices")),
                            channelLimit: Number(f.get("channelLimit")),
                          }),
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || "License operation failed");
                        if (data.key) {
                          setIssuedLicenseKey({
                            key: data.key,
                            email: overview.clients?.find((c) => c.id === editingLicenseClient)?.email || "",
                          });
                        }
                        setShowIssueLicenseModal(false);
                        setNotice("License saved successfully.");
                      });
                    }}
                  >
                    <div className="admin-dialog-body space-y-4">
                      <div className="form-group">
                        <label>Client Account</label>
                        <select
                          required
                          value={editingLicenseClient}
                          onChange={(e) => setEditingLicenseClient(e.target.value)}
                          className="w-full bg-[#111713] text-[#dce8df] border border-[#253229] rounded-lg p-2.5 text-xs"
                        >
                          {overview.clients.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} · {c.email}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="form-group">
                        <label>Expiration Date & Time</label>
                        <Input
                          required
                          type="datetime-local"
                          name="expiresAt"
                          defaultValue={
                            currentLic?.expiresAt
                              ? new Date(new Date(currentLic.expiresAt).getTime() - new Date().getTimezoneOffset() * 60000)
                                  .toISOString()
                                  .slice(0, 16)
                              : new Date(Date.now() + 30 * 86400000 - new Date().getTimezoneOffset() * 60000)
                                  .toISOString()
                                  .slice(0, 16)
                          }
                          className="bg-[#111713] border-[#253229]"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="form-group">
                          <label>Max Broadcaster Devices</label>
                          <Input
                            required
                            type="number"
                            name="maxDevices"
                            min={1}
                            max={1000}
                            defaultValue={currentLic?.maxDevices || 1}
                            className="bg-[#111713] border-[#253229]"
                          />
                        </div>

                        <div className="form-group">
                          <label>Channel Allowance</label>
                          <Input
                            required
                            type="number"
                            name="channelLimit"
                            min={1}
                            max={1000}
                            defaultValue={currentLic?.channelLimit || 1}
                            className="bg-[#111713] border-[#253229]"
                          />
                        </div>
                      </div>

                      <div className="form-group">
                        <label>Status</label>
                        <select
                          name="status"
                          defaultValue={currentLic?.status || "active"}
                          className="w-full bg-[#111713] text-[#dce8df] border border-[#253229] rounded-lg p-2.5 text-xs"
                        >
                          <option value="active">Active</option>
                          <option value="revoked">Revoked</option>
                        </select>
                      </div>
                    </div>

                    <div className="admin-dialog-footer">
                      <Button
                        type="button"
                        variant="outline"
                        className="border-[#2c3a30]"
                        onClick={() => setShowIssueLicenseModal(false)}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" disabled={busy} className="bg-[#b5edce] text-[#0f1f16] font-semibold">
                        {currentLic ? "Save License" : "Generate License Key"}
                      </Button>
                    </div>
                  </form>
                );
              })()}
            </div>
          </div>
        )}

        {/* MODAL 6: ISSUED LICENSE KEY DISPLAY */}
        {issuedLicenseKey && (
          <div className="admin-dialog-overlay" onClick={() => setIssuedLicenseKey(null)}>
            <div className="admin-dialog-content" onClick={(e) => e.stopPropagation()}>
              <div className="admin-dialog-header">
                <div className="flex items-center gap-2">
                  <Key className="size-4 text-[#b5edce]" />
                  <h3>Private License Key Generated</h3>
                </div>
                <button className="text-[#7d9084] hover:text-[#edf4ee]" onClick={() => setIssuedLicenseKey(null)}>
                  <X className="size-4" />
                </button>
              </div>

              <div className="admin-dialog-body space-y-4">
                <p className="text-xs text-[#a0b4a7] leading-relaxed">
                  This private license key is shown once. Download it or send it securely to the broadcaster.
                </p>

                <div className="form-group">
                  <label>License Key for {issuedLicenseKey.email}</label>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      type="password"
                      value={issuedLicenseKey.key}
                      className="bg-[#111713] border-[#253229] font-mono"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-[#2b3a30]"
                      onClick={() => copyToClipboard(issuedLicenseKey.key, "lic-key")}
                    >
                      {copiedText === "lic-key" ? <Check className="size-3.5 text-[#4ade80]" /> : <Copy className="size-3.5" />}
                    </Button>
                  </div>
                </div>

                <Button
                  className="w-full bg-[#b5edce] text-[#0f1f16] font-semibold"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify({ ...issuedLicenseKey, url: location.origin + "/" }, null, 2)], {
                        type: "application/json",
                      }),
                    );
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `signaldesk-license-${issuedLicenseKey.email || "client"}.json`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  Download signaldesk-license.json
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* MODAL 7: ACTIVATE BROADCASTER DEVICE */}
        {showActivateDeviceModal && (
          <div className="admin-dialog-overlay" onClick={() => setShowActivateDeviceModal(false)}>
            <div className="admin-dialog-content" onClick={(e) => e.stopPropagation()}>
              <div className="admin-dialog-header">
                <div className="flex items-center gap-2">
                  <Laptop className="size-4 text-[#b5edce]" />
                  <h3>Activate Broadcaster Device</h3>
                </div>
                <button className="text-[#7d9084] hover:text-[#edf4ee]" onClick={() => setShowActivateDeviceModal(false)}>
                  <X className="size-4" />
                </button>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const formEl = e.currentTarget;
                  const f = new FormData(formEl);

                  void work(async () => {
                    const res = await fetch("/api/control/license-activate", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        key: f.get("key"),
                        deviceId: f.get("deviceId"),
                        label: f.get("label"),
                        channelId: f.get("channelId"),
                      }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || "Device activation failed");
                    if (data.profile) {
                      downloadRelayProfile(data.profile);
                    }
                    setShowActivateDeviceModal(false);
                    setNotice("Device activated and profile downloaded.");
                  });
                }}
              >
                <div className="admin-dialog-body space-y-4">
                  <div className="form-group">
                    <label>License Key</label>
                    <Input
                      name="key"
                      type="password"
                      required
                      placeholder="Paste private license key..."
                      className="bg-[#111713] border-[#253229]"
                    />
                  </div>

                  <div className="form-group">
                    <label>Installation ID (UUID from desktop app)</label>
                    <Input
                      name="deviceId"
                      required
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      className="bg-[#111713] border-[#253229] font-mono text-xs"
                    />
                  </div>

                  <div className="form-group">
                    <label>Device Name / Label</label>
                    <Input
                      name="label"
                      maxLength={80}
                      required
                      placeholder="e.g. Newsroom Studio Laptop A"
                      className="bg-[#111713] border-[#253229]"
                    />
                  </div>

                  <div className="form-group">
                    <label>Target Channel</label>
                    <select
                      name="channelId"
                      required
                      className="w-full bg-[#111713] text-[#dce8df] border border-[#253229] rounded-lg p-2.5 text-xs"
                    >
                      {channels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.id})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="admin-dialog-footer">
                  <Button
                    type="button"
                    variant="outline"
                    className="border-[#2c3a30]"
                    onClick={() => setShowActivateDeviceModal(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy} className="bg-[#b5edce] text-[#0f1f16] font-semibold">
                    Activate & Download Profile
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* MODAL 8: CREATE USER ACCOUNT */}
        {showCreateUserModal && (
          <div className="admin-dialog-overlay" onClick={() => setShowCreateUserModal(false)}>
            <div className="admin-dialog-content" onClick={(e) => e.stopPropagation()}>
              <div className="admin-dialog-header">
                <h3>Add User Account</h3>
                <button className="text-[#7d9084] hover:text-[#edf4ee]" onClick={() => setShowCreateUserModal(false)}>
                  <X className="size-4" />
                </button>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const formEl = e.currentTarget;
                  const f = new FormData(formEl);

                  void work(async () => {
                    const res = await authClient.admin.createUser({
                      name: String(f.get("name")),
                      email: String(f.get("email")),
                      password: String(f.get("password")),
                      role: f.get("role") as "user",
                    });
                    if (res.error) throw new Error(res.error.message);
                    setShowCreateUserModal(false);
                    setNotice("User account created successfully.");
                  });
                }}
              >
                <div className="admin-dialog-body space-y-4">
                  <div className="form-group">
                    <label>Name</label>
                    <Input name="name" required placeholder="Full Name" className="bg-[#111713] border-[#253229]" />
                  </div>

                  <div className="form-group">
                    <label>Email Address</label>
                    <Input name="email" type="email" required placeholder="user@example.com" className="bg-[#111713] border-[#253229]" />
                  </div>

                  <div className="form-group">
                    <label>Initial Password</label>
                    <Input
                      name="password"
                      type="password"
                      minLength={12}
                      required
                      placeholder="Minimum 12 characters"
                      className="bg-[#111713] border-[#253229]"
                    />
                  </div>

                  <div className="form-group">
                    <label>Role</label>
                    <select
                      name="role"
                      className="w-full bg-[#111713] text-[#dce8df] border border-[#253229] rounded-lg p-2.5 text-xs"
                    >
                      {["user", "support", "crm", "admin"].map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="admin-dialog-footer">
                  <Button
                    type="button"
                    variant="outline"
                    className="border-[#2c3a30]"
                    onClick={() => setShowCreateUserModal(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy} className="bg-[#b5edce] text-[#0f1f16] font-semibold">
                    Create Account
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* MODAL 9: EDIT SUBSCRIPTION */}
        {showEditSubscriptionModal && (
          <div className="admin-dialog-overlay" onClick={() => setShowEditSubscriptionModal(null)}>
            <div className="admin-dialog-content" onClick={(e) => e.stopPropagation()}>
              <div className="admin-dialog-header">
                <h3>Edit Subscription Plan</h3>
                <button className="text-[#7d9084] hover:text-[#edf4ee]" onClick={() => setShowEditSubscriptionModal(null)}>
                  <X className="size-4" />
                </button>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const formEl = e.currentTarget;
                  const f = new FormData(formEl);

                  void work(async () => {
                    const res = await fetch("/api/control/subscription", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        userId: showEditSubscriptionModal.userId,
                        plan: f.get("plan"),
                        status: f.get("status"),
                        channelLimit: Number(f.get("channelLimit")),
                        expiresAt: f.get("expiresAt") || null,
                      }),
                    });
                    if (!res.ok) {
                      const err = await res.json();
                      throw new Error(err.error || "Subscription save failed");
                    }
                    setShowEditSubscriptionModal(null);
                    setNotice("Subscription updated.");
                  });
                }}
              >
                <div className="admin-dialog-body space-y-4">
                  <div className="form-group">
                    <label>Plan Name</label>
                    <Input
                      name="plan"
                      defaultValue={showEditSubscriptionModal.plan}
                      required
                      className="bg-[#111713] border-[#253229]"
                    />
                  </div>

                  <div className="form-group">
                    <label>Status</label>
                    <select
                      name="status"
                      defaultValue={showEditSubscriptionModal.status}
                      className="w-full bg-[#111713] text-[#dce8df] border border-[#253229] rounded-lg p-2.5 text-xs"
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                      <option value="suspended">Suspended</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Channel Allowance</label>
                    <Input
                      name="channelLimit"
                      type="number"
                      min={1}
                      max={1000}
                      defaultValue={showEditSubscriptionModal.channelLimit}
                      required
                      className="bg-[#111713] border-[#253229]"
                    />
                  </div>

                  <div className="form-group">
                    <label>Expires On</label>
                    <Input
                      name="expiresAt"
                      type="date"
                      defaultValue={
                        showEditSubscriptionModal.expiresAt
                          ? new Date(showEditSubscriptionModal.expiresAt).toISOString().split("T")[0]
                          : ""
                      }
                      className="bg-[#111713] border-[#253229]"
                    />
                  </div>
                </div>

                <div className="admin-dialog-footer">
                  <Button
                    type="button"
                    variant="outline"
                    className="border-[#2c3a30]"
                    onClick={() => setShowEditSubscriptionModal(null)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy} className="bg-[#b5edce] text-[#0f1f16] font-semibold">
                    Save Subscription
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
