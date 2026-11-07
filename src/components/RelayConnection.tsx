import { useEffect, useState, type SubmitEvent } from "react";
import { Radio } from "lucide-react";
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
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle", error: null });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!connected) return;
    void api<Connection>("/api/relay/config")
      .then((v) => {
        if (!cancelled) setDraft(v);
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
  function save(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    void action(async () => {
      const value = await api<Connection>("/api/relay/config", "PUT", {
        channelName: draft.channelName,
        host: draft.host,
        port: draft.port,
        viewerUrl: draft.viewerUrl,
        ...(key ? { streamKey: key } : {}),
      });
      setDraft(value);
      setKey("");
    }, "Relay connection saved on this computer.");
  }
  async function importProfile(file: File | undefined) {
    if (!file) return;
    await action(async () => {
      if (file.size > 8192) throw new Error("Connection profile is too large.");
      const profile = readRelayProfile(await file.text());
      setDraft(await api<Connection>("/api/relay/config", "PUT", profile));
      setKey("");
    }, "Connection profile imported and saved on this computer. Test the connection, then enable relay output.");
  }
  const playback = `${draft.viewerUrl.replace(/\/$/, "")}/streams/${draft.channelName}/index.m3u8`;
  return (
    <section className="relay-layout">
      <article className="panel relay-panel">
        <div className="panel-heading">
          <h2>
            <Radio size={18} /> LAN relay connection
          </h2>
          <span className="pill">{status.state}</span>
        </div>
        <p>
          Send your local channel to the shared server. Videos, schedules and
          playlists stay on this computer.
        </p>
        <label htmlFor="relay-profile">Import a connection profile</label>
        <Input
          id="relay-profile"
          type="file"
          accept=".json,application/json"
          disabled={!connected || busy || active}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void importProfile(file);
          }}
        />
        <p className="form-hint">
          Choose the private .connection.json file supplied by your
          administrator, or enter the fields below. Keep this file private: it
          contains your channel publishing key.
        </p>
        <form onSubmit={save} className="relay-form">
          <label htmlFor="relay-host">Relay IP or hostname</label>
          <Input
            id="relay-host"
            required
            placeholder="192.168.1.50"
            value={draft.host}
            disabled={active}
            onChange={(e) => setDraft({ ...draft, host: e.target.value })}
          />
          <label htmlFor="relay-port">SRT publishing port</label>
          <Input
            id="relay-port"
            type="number"
            required
            min={1}
            max={65535}
            value={draft.port}
            disabled={active}
            onChange={(e) =>
              setDraft({ ...draft, port: Number(e.target.value) })
            }
          />
          <label htmlFor="relay-channel">Assigned channel ID</label>
          <Input
            id="relay-channel"
            required
            placeholder="news-a"
            value={draft.channelName}
            disabled={active}
            onChange={(e) =>
              setDraft({ ...draft, channelName: e.target.value })
            }
          />
          <label htmlFor="relay-key">Publishing key</label>
          <Input
            id="relay-key"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={
              draft.configured
                ? "Saved; leave blank to keep"
                : "From the relay administrator"
            }
            disabled={active}
            onChange={(e) => setKey(e.target.value)}
          />
          <label htmlFor="relay-viewer">Relay web address</label>
          <Input
            id="relay-viewer"
            required
            placeholder="http://192.168.1.50:8088"
            value={draft.viewerUrl}
            disabled={active}
            onChange={(e) => setDraft({ ...draft, viewerUrl: e.target.value })}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={!connected || busy || active}
          >
            Save connection
          </Button>
        </form>
        {draft.configured && (
          <>
            <Button
              variant="outline"
              disabled={busy || !connected}
              onClick={() =>
                void action(
                  () => api("/api/relay/test", "POST", {}),
                  "Relay reachable and channel registered. Publishing verifies the SRT port and key.",
                )
              }
            >
              Test relay connection
            </Button>
            <p className="relay-url">
              IPTV playback: <code>{playback}</code>
            </p>
            <Button
              disabled={!connected || busy}
              onClick={() =>
                void action(
                  () =>
                    api(`/api/relay/${active ? "stop" : "start"}`, "POST", {}),
                  active
                    ? "Relay output stopped; local playout continues."
                    : "Relay output enabled. It sends when local playout is live.",
                )
              }
            >
              {active ? "Stop relay output" : "Enable relay output"}
            </Button>
          </>
        )}
        <p>
          Enable output before a scheduled start, or while a local program is
          live. Publishing reconnects automatically while this output remains
          enabled. Stop all broadcasting using the main Stop button.
        </p>
        {status.error && <p role="status">{status.error}</p>}
      </article>
      {error && (
        <p role="alert" className="relay-feedback">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="relay-feedback">
          {notice}
        </p>
      )}
    </section>
  );
}
