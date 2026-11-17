import { useEffect, useRef, useState, type SubmitEvent } from "react";
import Hls from "hls.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadRelayProfile } from "@/lib/relay";

interface Policy {
  domain: string;
  enabled: boolean;
  maxReaders: number;
  egressMbps: number;
  ingestMbps: number;
  licenseRequired?: boolean;
}
interface Channel {
  id: string;
  name: string;
  path: string;
  online: boolean;
  readers: number;
  policy: Policy;
}
interface Platform {
  publicHost: string;
  srtPort: number;
  publicWebUrl: string;
  adminDomain: string;
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
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
export default function RelayAdmin({ accountMode = false }: { accountMode?: boolean }) {
  const Root = accountMode ? 'div' : 'main';
  const request = (path: string, token = '', method = 'GET', body?: unknown) =>
    relayRequest(accountMode ? '/api/control/relay' + path : path, accountMode ? '' : token, method, body);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [token, setToken] = useState("");
  const [unlocked, setUnlocked] = useState(accountMode);
  const [platform, setPlatform] = useState(initialPlatform);
  const [id, setId] = useState(""),
    [name, setName] = useState("");
  const [policy, setPolicy] = useState<Policy>({ ...defaultPolicy });
  const [editing, setEditing] = useState<string | null>(null);
  const [secret, setSecret] = useState<{
    id: string;
    publishingKey: string;
  } | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Channel | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const localAdmin =
    typeof location !== "undefined" &&
    (location.hostname === "localhost" ||
      location.hostname === "[::1]" ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
        location.hostname,
      ));
  const canAdmin =
    typeof location !== "undefined" &&
    (location.protocol === "https:" || localAdmin);
  async function load() {
    const value = await request("/api/channels");
    setChannels(value.channels);
  }
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const value = await request("/api/channels");
        if (!cancelled) setChannels(value.channels);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    void request("/api/platform")
      .then(setPlatform)
      .catch((e) => setError(String(e)));
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!selected || !video.current) return;
    const player = video.current;
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(selected.path);
      hls.attachMedia(player);
      return () => hls.destroy();
    }
    player.src = selected.path;
    return () => {
      player.removeAttribute("src");
      player.load();
    };
  }, [selected]);
  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function reset() {
    setEditing(null);
    setId("");
    setName("");
    setPolicy({ ...defaultPolicy });
  }
  function saveChannel(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    void work(async () => {
      if (editing) {
        await request(`/api/channels/${editing}`, token, "PUT", {
          name,
          policy,
        });
        setNotice(
          "Channel settings saved. Session-limit changes reconnect the publisher. Bitrate is checked every five seconds.",
        );
      } else {
        setSecret(
          await request("/api/channels", token, "POST", { id, name, policy }),
        );
        setNotice(
          "Channel created. Download its private broadcaster profile below.",
        );
      }
      reset();
    });
  }
  return (
    <Root className="relay-console">
      <header className="relay-console-heading">
        <div>
          <span className="eyebrow">SIGNALDESK / RELAY</span>
          <h1>Live channels.</h1>
        <a href="/account/">Client & team sign in →</a>
          <p>
            Broadcasters keep their programs and schedules on their own
            computers.
          </p>
        </div>
        <span className="pill">
          {channels.filter((c) => c.online).length} on air / {channels.length}{" "}
          channels
        </span>
      </header>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <section className="relay-directory" aria-label="Channel directory">
        {channels.map((channel) => (
          <article className="panel relay-panel" key={channel.id}>
            <div className="panel-heading">
              <h2>{channel.name}</h2>
              <span className="pill">
                {!channel.policy.enabled
                  ? "DISABLED"
                  : channel.online
                    ? "LIVE"
                    : "OFFLINE"}
              </span>
            </div>
            <p>
              {channel.id} · {channel.readers} HLS sessions
            </p>
            <a className="relay-url" href={channel.path}>
              {platform.publicWebUrl.replace(/\/$/, "")}
              {channel.path}
            </a>
            {channel.policy.domain && (
              <a
                className="relay-url"
                href={`https://${channel.policy.domain}/live/index.m3u8`}
              >
                https://{channel.policy.domain}/live/index.m3u8
              </a>
            )}
            <Button
              variant="outline"
              disabled={!channel.online || !channel.policy.enabled}
              onClick={() => setSelected(channel)}
            >
              Watch channel
            </Button>
            {unlocked && (
              <>
                <p>
                  {channel.policy.maxReaders} maximum HLS sessions ·{" "}
                  {channel.policy.egressMbps} Mbps aggregate output ·{" "}
                  {channel.policy.ingestMbps} Mbps publisher limit
                </p>
                <div className="relay-buttons">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setEditing(channel.id);
                      setId(channel.id);
                      setName(channel.name);
                      setPolicy({ ...channel.policy });
                      setSecret(null);
                    }}
                  >
                    Edit channel
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
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
                            ? "Channel disabled and publisher disconnected."
                            : "Channel enabled.",
                        );
                      })
                    }
                  >
                    {channel.policy.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Rotate ${channel.name}'s publishing key? Its broadcaster will disconnect.`,
                        )
                      )
                        void work(async () => {
                          setSecret(
                            await request(
                              `/api/channels/${channel.id}/rotate`,
                              token,
                              "POST",
                            ),
                          );
                        });
                    }}
                  >
                    Rotate key
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove ${channel.name} and disconnect its broadcaster?`,
                        )
                      )
                        void work(async () => {
                          await request(
                            `/api/channels/${channel.id}`,
                            token,
                            "DELETE",
                          );
                          setSecret(null);
                        });
                    }}
                  >
                    Remove channel
                  </Button>
                </div>
              </>
            )}
          </article>
        ))}
      </section>
      {!channels.length && (
        <p>Unlock super administration to create your first channel.</p>
      )}
      {selected && (
        <section className="panel relay-panel">
          <h2>{selected.name}</h2>
          <video ref={video} controls playsInline className="relay-video" />
          <Button variant="outline" onClick={() => setSelected(null)}>
            Close player
          </Button>
        </section>
      )}
      {!accountMode && (
      <section className="panel relay-panel">
        <h2>Super administration</h2>
        {!canAdmin && (
          <p className="form-error">
            Open the relay’s private LAN address to configure domains, then use
            HTTPS for public administration.
          </p>
        )}
        <p>
          Use the relay administrator token. It stays in this page’s memory.
          Public administration requires HTTPS.
        </p>
        <form
          className="relay-form"
          onSubmit={(e) => {
            e.preventDefault();
            void work(async () => {
              await request("/api/admin/channels", token);
              setUnlocked(true);
              setNotice("Super administration unlocked.");
            });
          }}
        >
          <label htmlFor="admin-token">Administrator token</label>
          <Input
            disabled={!canAdmin}
            id="admin-token"
            type="password"
            autoComplete="off"
            required
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setUnlocked(false);
              setSecret(null);
            }}
          />
          <Button disabled={busy || !canAdmin} type="submit">
            Unlock administration
          </Button>
          {token && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setToken("");
                setUnlocked(false);
                setSecret(null);
                reset();
              }}
            >
              Lock administration
            </Button>
          )}
        </form>
      </section>
      )}
      {unlocked && (
        <>
          <section className="panel relay-panel">
            <h2>Public relay settings</h2>
            <form
              className="relay-form"
              onSubmit={(e) => {
                e.preventDefault();
                void work(async () => {
                  await request("/api/platform", token, "PUT", platform);
                  setNotice(
                    "Public endpoints saved. Router forwarding and DNS must match these addresses.",
                  );
                });
              }}
            >
              <label htmlFor="public-host">
                Public publishing IP or hostname
              </label>
              <Input
                id="public-host"
                required
                value={platform.publicHost}
                onChange={(e) =>
                  setPlatform({ ...platform, publicHost: e.target.value })
                }
              />
              <label htmlFor="srt-port">Public SRT UDP port</label>
              <Input
                id="srt-port"
                type="number"
                min={1}
                max={65535}
                required
                value={platform.srtPort}
                onChange={(e) =>
                  setPlatform({ ...platform, srtPort: Number(e.target.value) })
                }
              />
              <label htmlFor="public-web">Public website origin</label>
              <Input
                id="public-web"
                type="url"
                required
                value={platform.publicWebUrl}
                onChange={(e) =>
                  setPlatform({ ...platform, publicWebUrl: e.target.value })
                }
              />
              <label htmlFor="admin-domain">Administration domain</label>
              <Input
                id="admin-domain"
                placeholder="tv.example.com"
                value={platform.adminDomain}
                onChange={(e) =>
                  setPlatform({
                    ...platform,
                    adminDomain: e.target.value.toLowerCase().trim(),
                    ...(e.target.value.trim()
                      ? {
                          publicWebUrl: `https://${e.target.value.toLowerCase().trim()}`,
                        }
                      : {}),
                  })
                }
              />
              <p className="form-hint">
                Create a DNS A record pointing your domain to{" "}
                {platform.publicHost}. The public Docker gateway obtains HTTPS
                certificates for saved administration and channel domains. Ports
                80 and 443 must reach the gateway.
              </p>
              <Button type="submit" disabled={busy}>
                Save public settings
              </Button>
            </form>
          </section>
          <section className="panel relay-panel">
            <h2>{editing ? `Edit ${editing}` : "Create channel"}</h2>
            <form className="relay-form" onSubmit={saveChannel}>
              <label htmlFor="channel-id">Channel ID</label>
              <Input
                id="channel-id"
                required
                pattern="[a-z0-9-]{1,64}"
                disabled={!!editing}
                value={id}
                onChange={(e) => setId(e.target.value)}
              />
              <label htmlFor="channel-name">Display name</label>
              <Input
                id="channel-name"
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <label htmlFor="channel-domain">Channel domain</label>
              <Input
                id="channel-domain"
                placeholder="news.example.com"
                value={policy.domain}
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    domain: e.target.value.toLowerCase().trim(),
                  })
                }
              />
              <p className="form-hint">
                Point its DNS A record to {platform.publicHost}. Its IPTV URL is
                https://your-domain/live/index.m3u8.
              </p>
              <label htmlFor="max-readers">
                Maximum simultaneous HLS sessions
              </label>
              <Input
                id="max-readers"
                type="number"
                min={1}
                max={10000}
                required
                value={policy.maxReaders}
                onChange={(e) =>
                  setPolicy({ ...policy, maxReaders: Number(e.target.value) })
                }
              />
              <label htmlFor="egress">Aggregate HLS output limit (Mbps)</label>
              <Input
                id="egress"
                type="number"
                min={1}
                max={10000}
                required
                value={policy.egressMbps}
                onChange={(e) =>
                  setPolicy({ ...policy, egressMbps: Number(e.target.value) })
                }
              />
              <label htmlFor="ingest">Maximum publisher bitrate (Mbps)</label>
              <Input
                id="ingest"
                type="number"
                min={1}
                max={1000}
                required
                value={policy.ingestMbps}
                onChange={(e) =>
                  setPolicy({ ...policy, ingestMbps: Number(e.target.value) })
                }
              />
              <p className="form-hint">
                Output bandwidth is shared by every viewer. Allow headroom for
                audio and transport. A publisher exceeding its measured limit is
                disconnected. Changing session limits reconnects the publisher.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={policy.enabled}
                  onChange={(e) =>
                    setPolicy({ ...policy, enabled: e.target.checked })
                  }
                />{" "}
                Channel enabled
              </label>
              <div className="relay-buttons">
                <Button type="submit" disabled={busy}>
                  {editing ? "Save channel settings" : "Create channel"}
                </Button>
                {editing && (
                  <Button type="button" variant="outline" onClick={reset}>
                    Cancel editing
                  </Button>
                )}
              </div>
            </form>
          </section>
        </>
      )}
      {unlocked && secret && (
        <section className="panel relay-panel" role="status">
          <h2>Publishing key for {secret.id}</h2>
          <p>
            Download this private profile for the broadcaster. The key is shown
            once after creation or rotation.
          </p>
          <Input
            aria-label="New publishing key"
            readOnly
            type="password"
            value={secret.publishingKey}
          />
          <p>
            Publishing host {platform.publicHost} · UDP {platform.srtPort}
          </p>
          <Button
            onClick={() =>
              downloadRelayProfile({
                format: "signaldesk-connection-v1",
                channelName: secret.id,
                host: platform.publicHost,
                port: platform.srtPort,
                viewerUrl: platform.publicWebUrl.replace(/\/$/, ""),
                streamKey: secret.publishingKey,
              })
            }
          >
            Download connection profile
          </Button>
        </section>
      )}
    </Root>
  );
}
