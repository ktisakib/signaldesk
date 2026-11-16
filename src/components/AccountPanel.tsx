import { useEffect, useState, type SubmitEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import RelayAdmin from "./RelayAdmin";
import { permits } from "../../server/permissions";
interface Person {
  id: string;
  name: string;
  email: string;
  role: string;
}
interface Channel {
  id: string;
  name: string;
  online: boolean;
}
interface Subscription {
  userId: string;
  plan: string;
  status: string;
  channelLimit: number;
  expiresAt: string | null;
}
interface Overview {
  actor: Person;
  clients: Person[];
  channels: Channel[];
  owners: { channelId: string; userId: string }[];
  subscriptions: Subscription[];
}
export default function AccountPanel() {
  const session = authClient.useSession();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch("/api/control/overview");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Accounts unavailable");
    setData(value);
  }
  useEffect(() => {
    if (session.data) void load().catch((e) => setError(String(e)));
  }, [session.data]);
  async function work(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if ((await authClient.getSession()).data) await load();
      else setData(null);
      setNotice("Changes saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function post(path: string, body: unknown) {
    const response = await fetch("/api/control/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
  }
  function form(
    e: SubmitEvent<HTMLFormElement>,
    action: (values: FormData) => Promise<unknown>,
  ) {
    e.preventDefault();
    const values = new FormData(e.currentTarget);
    void work(() => action(values));
  }
  const admin = permits(data?.actor.role, "users");
  const crm = permits(data?.actor.role, "subscriptions");
  const people = (name: string) => (
    <label>
      {name}
      <select name="userId" required className="account-select">
        <option value="">Choose an account</option>
        {data?.clients.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.email}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <main className="account-shell">
      <header className="account-header">
        <div>
          <p className="eyebrow">SIGNALDESK / ACCOUNTS</p>
          <h1>Channel operations</h1>
          <p>Manage your TV identity, service and team access.</p>
        </div>
        <nav>
          <a href="/relay/">Live channels</a>
          {session.data && (
            <Button
              variant="outline"
              onClick={() =>
                void work(async () => {
                  await authClient.signOut();
                  setData(null);
                })
              }
            >
              Sign out
            </Button>
          )}
        </nav>
      </header>
      {error && (
        <p role="alert" className="account-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {session.isPending ? (
        <p>Checking your session…</p>
      ) : !session.data ? (
        <section className="account-login">
          <h2>Welcome back</h2>
          <p>Use the account created by your platform administrator.</p>
          <form
            onSubmit={(e) =>
              form(e, async (f) => {
                const r = await authClient.signIn.email({
                  email: String(f.get("email")),
                  password: String(f.get("password")),
                });
                if (r.error) throw new Error(r.error.message);
              })
            }
          >
            <label>
              Email
              <Input
                name="email"
                type="email"
                autoComplete="username"
                required
              />
            </label>
            <label>
              Password
              <Input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <Button type="submit" disabled={busy}>
              Sign in
            </Button>
          </form>
          <p>
            First setup? Connect the database and create the first administrator
            using the setup guide.
          </p>
        </section>
      ) : (
        <>
          <div className="account-summary">
            <span>{session.data.user.name}</span>
            <strong>{data?.actor.role || "user"}</strong>
            <span>{data?.channels.length ?? 0} channels available</span>
          </div>
          <section>
            <h2>Your TV channels</h2>
            <p>
              Names appear to viewers. Stream IDs and laptop connections stay
              the same.
            </p>
            <div className="account-channels">
              {data?.channels.map((c) => (
                <article key={c.id}>
                  <div className="account-row">
                    <h3>{c.name}</h3>
                    <span>{c.online ? "ON AIR" : "OFFLINE"}</span>
                  </div>
                  <small>Stream ID: {c.id}</small>
                  <form
                    onSubmit={(e) =>
                      form(e, (f) =>
                        post("rename", {
                          channelId: c.id,
                          name: f.get("name"),
                        }),
                      )
                    }
                  >
                    <label>
                      TV channel name
                      <Input
                        name="name"
                        defaultValue={c.name}
                        maxLength={100}
                        required
                      />
                    </label>
                    <Button type="submit" disabled={busy}>
                      Save name
                    </Button>
                  </form>
                  {admin && (
                    <form
                      onSubmit={(e) =>
                        form(e, (f) =>
                          post("assign", {
                            channelId: c.id,
                            userId: f.get("userId"),
                          }),
                        )
                      }
                    >
                      {people("Channel owner")}
                      <Button type="submit" variant="outline" disabled={busy}>
                        Assign owner
                      </Button>
                    </form>
                  )}
                </article>
              ))}
            </div>
            {data?.channels.length === 0 && (
              <p>
                No channels assigned. Ask your administrator to assign your
                channel.
              </p>
            )}
            {admin && (
              <p>
                <a href="/relay/">
                  Create channels and configure stream limits in relay
                  administration →
                </a>
              </p>
            )}
          </section>
          <section>
            <h2>Subscriptions</h2>
            <p>
              Service entitlements are managed by your administrator. No
              automatic payments are collected.
            </p>
            <div className="account-table">
              <table>
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Channels</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.subscriptions.map((s) => (
                    <tr key={s.userId}>
                      <td>
                        {data.clients.find((p) => p.id === s.userId)?.name ||
                          session.data?.user.name}
                      </td>
                      <td>{s.plan}</td>
                      <td>{s.status}</td>
                      <td>{s.channelLimit}</td>
                      <td>
                        {s.expiresAt
                          ? new Date(s.expiresAt).toLocaleDateString()
                          : "No expiry"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {crm && (
              <form
                className="account-grid"
                onSubmit={(e) =>
                  form(e, (f) =>
                    post("subscription", {
                      userId: f.get("userId"),
                      plan: f.get("plan"),
                      status: f.get("status"),
                      channelLimit: Number(f.get("channelLimit")),
                      expiresAt: f.get("expiresAt") || null,
                    }),
                  )
                }
              >
                {people("Client")}
                <label>
                  Plan
                  <Input
                    name="plan"
                    defaultValue="Starter"
                    maxLength={80}
                    required
                  />
                </label>
                <label>
                  Status
                  <select name="status" className="account-select">
                    <option>active</option>
                    <option>inactive</option>
                    <option>suspended</option>
                  </select>
                </label>
                <label>
                  Channel allowance
                  <Input
                    type="number"
                    name="channelLimit"
                    defaultValue={1}
                    min={1}
                    max={1000}
                    required
                  />
                </label>
                <label>
                  Expires on
                  <Input name="expiresAt" type="date" />
                </label>
                <Button type="submit" disabled={busy}>
                  Save subscription
                </Button>
              </form>
            )}
          </section>
          {admin && (
            <section>
              <h2>People & permissions</h2>
              <p>
                Administrators manage the platform. CRM manages subscriptions.
                Support can rename only explicitly assigned channels. Clients
                manage their own channels.
              </p>
              <div className="account-table">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.clients.map((p) => (
                      <tr key={p.id}>
                        <td>{p.name}</td>
                        <td>{p.email}</td>
                        <td>{p.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <form
                className="account-grid"
                onSubmit={(e) =>
                  form(e, async (f) => {
                    const r = await authClient.admin.createUser({
                      name: String(f.get("name")),
                      email: String(f.get("email")),
                      password: String(f.get("password")),
                      role: f.get("role") as "user",
                    });
                    if (r.error) throw new Error(r.error.message);
                  })
                }
              >
                <label>
                  Name
                  <Input name="name" required />
                </label>
                <label>
                  Email
                  <Input name="email" type="email" required />
                </label>
                <label>
                  Initial password
                  <Input
                    name="password"
                    type="password"
                    minLength={12}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <label>
                  Role
                  <select name="role" className="account-select">
                    {["user", "support", "crm", "admin"].map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <Button type="submit" disabled={busy}>
                  Create account
                </Button>
              </form>
              <form
                className="account-grid"
                onSubmit={(e) =>
                  form(e, async (f) => {
                    const r = await authClient.admin.setRole({
                      userId: String(f.get("userId")),
                      role: f.get("role") as "user",
                    });
                    if (r.error) throw new Error(r.error.message);
                  })
                }
              >
                {people("Account")}
                <label>
                  New role
                  <select name="role" className="account-select">
                    {["user", "support", "crm", "admin"].map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <Button type="submit" disabled={busy} variant="outline">
                  Update role
                </Button>
              </form>
              <h3>Delegate channel support</h3>
              <form
                className="account-grid"
                onSubmit={(e) =>
                  form(e, (f) =>
                    post("support-grant", {
                      userId: f.get("userId"),
                      channelId: f.get("channelId"),
                      enabled: f.get("enabled") === "grant",
                    }),
                  )
                }
              >
                {people("Support account")}
                <label>
                  Channel
                  <select name="channelId" required className="account-select">
                    {data?.channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Access
                  <select name="enabled" className="account-select">
                    <option value="grant">Grant support access</option>
                    <option value="revoke">Revoke support access</option>
                  </select>
                </label>
                <Button type="submit" disabled={busy} variant="outline">
                  Save access
                </Button>
              </form>
            </section>
          )}
          {admin && (
            <section>
              <h2>Relay & channel configuration</h2>
              <RelayAdmin accountMode />
            </section>
          )}
        </>
      )}
    </main>
  );
}
