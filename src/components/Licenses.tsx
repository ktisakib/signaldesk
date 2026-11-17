import { useState, type SubmitEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadRelayProfile, type RelayProfile } from "@/lib/relay";
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
interface Props {
  admin: boolean;
  currentUserId: string;
  clients: { id: string; name: string; email: string }[];
  channels: { id: string; name: string }[];
  licenses: License[];
  devices: LicensedDevice[];
  refresh: () => Promise<void>;
}
export default function Licenses({
  admin,
  currentUserId,
  clients,
  channels,
  licenses,
  devices,
  refresh,
}: Props) {
  const [client, setClient] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ key: string; email: string } | null>(
    null,
  );
  const selected = licenses.find((l) => l.userId === client);
  async function action(path: string, body: unknown) {
    setBusy(true);
    setError("");
    setIssued(null);
    try {
      const r = await fetch("/api/control/" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const v = await r.json();
      if (!r.ok) throw Error(v.error || "License operation failed");
      if (v.key)
        setIssued({
          key: v.key,
          email: clients.find((c) => c.id === client)?.email || "",
        });
      if (v.profile) downloadRelayProfile(v.profile as RelayProfile);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function submit(
    e: SubmitEvent<HTMLFormElement>,
    path: string,
    body: (f: FormData) => unknown,
  ) {
    e.preventDefault();
    void action(path, body(new FormData(e.currentTarget)));
  }
  const localTime = (date: string) => {
    const d = new Date(date);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  return (
    <section id="licenses">
      <h2>Licenses & broadcaster devices</h2>
      <p>
        One account can run multiple channels. The license controls its expiry,
        registered broadcaster installations and channel allowance.
      </p>
      {error && (
        <p role="alert" className="account-error">
          {error}
        </p>
      )}
      <div className="account-table">
        <table>
          <thead>
            <tr>
              <th>Client / key</th>
              <th>Status</th>
              <th>Expires</th>
              <th>Devices</th>
              <th>Channels</th>
            </tr>
          </thead>
          <tbody>
            {licenses.map((l) => (
              <tr key={l.userId}>
                <td>
                  {clients.find((c) => c.id === l.userId)?.name ||
                    "Your account"}
                  <br />
                  <small>{l.keyPrefix}…</small>
                </td>
                <td>
                  {new Date(l.expiresAt) <= new Date() ? "expired" : l.status}
                </td>
                <td>{new Date(l.expiresAt).toLocaleString()}</td>
                <td>
                  {
                    devices.filter((d) => d.userId === l.userId && !d.revoked)
                      .length
                  }{" "}
                  / {l.maxDevices}
                </td>
                <td>{l.channelLimit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {admin && (
        <>
          <h3>Issue or renew an account license</h3>
          <form
            key={client}
            className="account-grid"
            onSubmit={(e) =>
              submit(
                e,
                selected ? "license-update" : "license-create",
                (f) => ({
                  userId: client,
                  status: f.get("status"),
                  expiresAt: new Date(String(f.get("expiresAt"))).toISOString(),
                  maxDevices: Number(f.get("maxDevices")),
                  channelLimit: Number(f.get("channelLimit")),
                }),
              )
            }
          >
            <label>
              Client
              <select
                required
                value={client}
                onChange={(e) => setClient(e.target.value)}
                className="account-select"
              >
                <option value="">Choose an account</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.email}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Expires at (your local time)
              <Input
                required
                type="datetime-local"
                name="expiresAt"
                defaultValue={localTime(
                  selected?.expiresAt ||
                    new Date(Date.now() + 30 * 86400000).toISOString(),
                )}
              />
            </label>
            <label>
              Maximum devices
              <Input
                required
                type="number"
                name="maxDevices"
                min={1}
                max={1000}
                defaultValue={selected?.maxDevices || 1}
              />
            </label>
            <label>
              Maximum channels
              <Input
                required
                type="number"
                name="channelLimit"
                min={1}
                max={1000}
                defaultValue={selected?.channelLimit || 1}
              />
            </label>
            <label>
              Status
              <select
                name="status"
                defaultValue={selected?.status || "active"}
                className="account-select"
              >
                <option value="active">Active</option>
                <option value="revoked">Revoked</option>
              </select>
            </label>
            <Button disabled={busy} type="submit">
              {selected ? "Save license" : "Generate license key"}
            </Button>
          </form>
          {selected && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void action("license-rotate", { userId: client })}
            >
              Replace key and revoke all device activations
            </Button>
          )}
          {issued && (
            <div role="status">
              <p>
                The new key is shown once. Download it before leaving this page.
              </p>
              <Input
                aria-label="New license key"
                type="password"
                readOnly
                value={issued.key}
              />
              <Button
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob(
                      [
                        JSON.stringify(
                          { ...issued, url: location.origin + "/account/" },
                          null,
                          2,
                        ),
                      ],
                      { type: "application/json" },
                    ),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "signaldesk-license.json";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Download private license key
              </Button>
            </div>
          )}
          <p>
            Assign channels using the channel owner controls. Creating a license
            enables relay enforcement for that account’s channels. Licensed
            devices need the updated desktop app.
          </p>
        </>
      )}
      <h3>Registered devices</h3>
      <div className="account-table">
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Installation ID</th>
              <th>Status</th>
              {admin && <th>Access</th>}
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.userId + d.deviceId}>
                <td>{d.label}</td>
                <td>
                  <code>{d.deviceId}</code>
                </td>
                <td>{d.revoked ? "Released" : "Registered"}</td>
                {admin && (
                  <td>
                    <Button
                      variant="outline"
                      disabled={busy || d.revoked}
                      onClick={() =>
                        void action("license-device-revoke", {
                          userId: d.userId,
                          deviceId: d.deviceId,
                        })
                      }
                    >
                      Release device
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {licenses.some((l) => l.userId === currentUserId) && (
        <>
          <h3>Activate this broadcaster</h3>
          <p>
            Copy the installation ID from the desktop app’s relay panel. Enter
            your license key and choose a channel, then import the downloaded
            profile into that same installation. Repeat for other channels on
            the same device without using another slot.
          </p>
          <form
            className="account-grid"
            onSubmit={(e) =>
              submit(e, "license-activate", (f) => ({
                key: f.get("key"),
                deviceId: f.get("deviceId"),
                label: f.get("label"),
                channelId: f.get("channelId"),
              }))
            }
          >
            <label>
              License key
              <Input name="key" type="password" autoComplete="off" required />
            </label>
            <label>
              Installation ID
              <Input
                name="deviceId"
                required
                placeholder="ID from your desktop app"
              />
            </label>
            <label>
              Device name
              <Input
                name="label"
                maxLength={80}
                required
                placeholder="Newsroom laptop"
              />
            </label>
            <label>
              Channel
              <select className="account-select" name="channelId" required>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <Button disabled={busy} type="submit">
              Activate & download profile
            </Button>
          </form>
        </>
      )}
    </section>
  );
}
