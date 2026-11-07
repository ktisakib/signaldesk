import { useEffect, useRef, useState, type SubmitEvent } from "react";
import Hls from "hls.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadRelayProfile } from "@/lib/relay";
interface Channel {
  id: string;
  name: string;
  path: string;
  online: boolean;
  readers: number;
}
export default function RelayAdmin() {
  const [channels, setChannels] = useState<Channel[]>([]),
    [token, setToken] = useState(""),
    [id, setId] = useState(""),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [secret, setSecret] = useState<{
      id: string;
      publishingKey: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Channel | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  async function load() {
    const r = await fetch("/api/channels");
    if (!r.ok) throw new Error("Relay media server is unavailable");
    const body = await r.json();
    setChannels(body.channels);
  }
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      if (cancelled) return;
      try {
        await load();
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    void poll();
    const t = setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  useEffect(() => {
    if (!selected || !video.current) return;
    const v = video.current;
    if (Hls.isSupported()) {
      const h = new Hls();
      h.loadSource(selected.path);
      h.attachMedia(v);
      return () => h.destroy();
    }
    v.src = selected.path;
    return () => {
      v.removeAttribute("src");
      v.load();
    };
  }, [selected]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError("");
    setSecret(null);
    try {
      const r = await fetch(path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!r.ok) throw new Error(await r.text());
      const value = await r.json();
      if (value.publishingKey) setSecret(value);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function create(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    void mutate("/api/channels", "POST", { id, name });
  }
  return (
    <main className="relay-console">
      <header className="relay-console-heading">
        <div>
          <span className="eyebrow">SIGNALDESK / LAN RELAY</span>
          <h1>Channels on your network.</h1>
          <p>
            Live distribution only. Broadcasters keep their videos and schedules
            on their own computers.
          </p>
        </div>
        <span className="pill">
          {channels.filter((c) => c.online).length} on air / {channels.length}{" "}
          channels
        </span>
      </header>
      {error && <p role="alert">{error}</p>}
      <section className="relay-directory" aria-label="Channel directory">
        {channels.map((c) => (
          <article className="panel relay-panel" key={c.id}>
            <div className="panel-heading">
              <h2>{c.name}</h2>
              <span className="pill">{c.online ? "LIVE" : "OFFLINE"}</span>
            </div>
            <p>
              {c.id} · {c.readers} HLS sessions
            </p>
            <a className="relay-url" href={c.path}>
              {typeof location !== "undefined" ? location.origin : ""}
              {c.path}
            </a>
            <Button
              variant="outline"
              disabled={!c.online}
              onClick={() => setSelected(c)}
            >
              Watch channel
            </Button>
            {token && (
              <div className="relay-buttons">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Rotate the key for ${c.name}? This disconnects its broadcaster.`,
                      )
                    )
                      void mutate(`/api/channels/${c.id}/rotate`, "POST");
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
                        `Remove ${c.name} and disconnect its broadcaster?`,
                      )
                    )
                      void mutate(`/api/channels/${c.id}`, "DELETE");
                  }}
                >
                  Remove channel
                </Button>
              </div>
            )}
          </article>
        ))}
      </section>
      {!channels.length && (
        <p>No channels yet. Unlock administration to create the first one.</p>
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
      <section className="panel relay-panel">
        <h2>Relay administration</h2>
        <p>
          Use the admin token from the server’s private .env.relay file. It
          stays in this page’s memory until you clear it or close the page. HTTP
          administration is for a trusted LAN only.
        </p>
        <label htmlFor="admin-token">Administrator token</label>
        <Input
          id="admin-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        {token && (
          <Button
            variant="outline"
            onClick={() => {
              setToken("");
              setSecret(null);
            }}
          >
            Clear admin token
          </Button>
        )}
        {token && (
          <form className="relay-form" onSubmit={create}>
            <label htmlFor="channel-id">Channel ID</label>
            <Input
              id="channel-id"
              required
              pattern="[a-z0-9-]{1,64}"
              placeholder="news-a"
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
            <Button disabled={busy} type="submit">
              Create channel
            </Button>
          </form>
        )}
        {secret && (
          <div role="status">
            <h3>Publishing key for {secret.id}</h3>
            <p>
              Copy this once to the broadcaster’s Relay connection screen.
              Rotating it disconnects the old publisher.
            </p>
            <Input
              aria-label="New publishing key"
              readOnly
              value={secret.publishingKey}
            />
            <p>
              Server: {typeof location !== "undefined" ? location.hostname : ""}{" "}
              · SRT port: 8890 (unless changed by the administrator)
            </p>
            <Button
              variant="outline"
              onClick={() =>
                downloadRelayProfile({
                  format: "signaldesk-connection-v1",
                  channelName: secret.id,
                  host: location.hostname,
                  port: 8890,
                  viewerUrl: location.origin,
                  streamKey: secret.publishingKey,
                })
              }
            >
              Download connection profile
            </Button>
            <p className="form-hint">
              Send this private file only to its broadcaster. It includes the
              publishing key. If you changed the SRT port, update the port in
              the desktop app.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
