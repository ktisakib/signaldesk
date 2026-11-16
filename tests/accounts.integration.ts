import assert from "node:assert/strict";
import { createServer } from "node:http";
assert.equal(
  process.env.ACCOUNTS_TEST_DATABASE,
  "1",
  "Use only the disposable account test database",
);
assert.equal(new URL(process.env.DATABASE_URL!).hostname, "127.0.0.1");
const channels = [
  {
    id: "test-news",
    name: "News TV",
    policy: {
      enabled: true,
      maxReaders: 10,
      egressMbps: 10,
      ingestMbps: 5,
      domain: "",
    },
  },
  {
    id: "other-news",
    name: "Other TV",
    policy: {
      enabled: true,
      maxReaders: 10,
      egressMbps: 10,
      ingestMbps: 5,
      domain: "",
    },
  },
];
const relay = createServer(async (req, res) => {
  assert.equal(
    req.headers.authorization,
    `Bearer ${process.env.RELAY_ADMIN_TOKEN}`,
  );
  res.setHeader("Content-Type", "application/json");
  if (req.method === "GET") return res.end(JSON.stringify({ channels }));
  let body = "";
  for await (const chunk of req) body += chunk;
  const c = channels.find((c) => req.url === `/api/channels/${c.id}`);
  assert.ok(c);
  c.name = JSON.parse(body).name;
  res.end('{"ok":true}');
});
await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
const address = relay.address();
assert.ok(address && typeof address !== "string");
process.env.RELAY_INTERNAL_URL = `http://127.0.0.1:${address.port}`;
const { auth } = await import("../server/auth");
const { control } = await import("../server/control");
const { sql } = await import("../server/db/client");
const origin = process.env.BETTER_AUTH_URL!;
const password = "Disposable-test-password-2026";
let clientIp = 1;
async function person(
  role: "admin" | "user" | "crm" | "support",
  suffix: string,
) {
  const email = `${suffix}-${Date.now()}@example.test`;
  const { user } = await auth.api.createUser({
    body: { email, password, name: suffix, role },
  });
  const response = await auth.handler(
    new Request(origin + "/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "x-forwarded-for": `192.0.2.${clientIp++}`,
      },
      body: JSON.stringify({ email, password }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  return { id: user.id, cookie };
}
try {
  const admin = await person("admin", "admin"),
    client = await person("user", "client"),
    other = await person("user", "other"),
    crm = await person("crm", "crm"),
    support = await person("support", "support");
  const call = (
    p: typeof client,
    path: string,
    body?: unknown,
    requestOrigin = origin,
  ) =>
    control(
      new Request(origin + "/api/control/" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Cookie: p.cookie,
          Origin: requestOrigin,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const subscription = {
    userId: client.id,
    plan: "News",
    status: "active",
    channelLimit: 1,
    expiresAt: null,
  };
  assert.equal((await call(client, "subscription", subscription)).status, 403);
  assert.equal((await call(client, "relay/api/admin/channels")).status, 403);
  assert.equal((await call(admin, "relay/api/admin/channels")).status, 200);
  assert.equal((await call(crm, "subscription", subscription)).status, 200);
  assert.equal(
    (await call(admin, "assign", { userId: client.id, channelId: "test-news" }))
      .status,
    200,
  );
  assert.equal(
    (
      await call(admin, "assign", {
        userId: client.id,
        channelId: "other-news",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(client, "rename", {
        channelId: "test-news",
        name: "Client TV",
      })
    ).status,
    200,
  );
  assert.equal(channels[0].name, "Client TV");
  assert.equal(
    (await call(other, "rename", { channelId: "test-news", name: "Stolen" }))
      .status,
    403,
  );
  assert.equal(
    (await call(crm, "rename", { channelId: "test-news", name: "CRM TV" }))
      .status,
    403,
  );
  assert.equal(
    (
      await call(support, "rename", {
        channelId: "test-news",
        name: "Support TV",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(admin, "support-grant", {
        userId: support.id,
        channelId: "test-news",
        enabled: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(support, "rename", {
        channelId: "test-news",
        name: "Support TV",
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(support, "rename", { channelId: "other-news", name: "No" }))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        client,
        "rename",
        { channelId: "test-news", name: "Bad origin" },
        "https://evil.example",
      )
    ).status,
    403,
  );
  const overview = await (await call(client, "overview")).json();
  assert.equal(overview.channels.length, 1);
  assert.equal(overview.clients.length, 0);
  assert.equal(
    (await call(crm, "subscription", { ...subscription, status: "suspended" }))
      .status,
    200,
  );
  assert.equal(
    (
      await call(client, "rename", {
        channelId: "test-news",
        name: "Suspended",
      })
    ).status,
    403,
  );
  const denied = await auth.handler(
    new Request(origin + "/api/auth/admin/set-role", {
      method: "POST",
      headers: {
        Cookie: client.cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: client.id, role: "admin" }),
    }),
  );
  assert.equal(denied.status, 403);
  console.log(
    "PASS: real PostgreSQL login, client isolation, CRM separation, scoped support, subscription allowance, suspension, CSRF and role escalation rejection",
  );
} finally {
  await sql.end();
  relay.close();
}
