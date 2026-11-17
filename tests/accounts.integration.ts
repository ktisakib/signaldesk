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
  if (req.url === "/api/platform")
    return res.end(
      JSON.stringify({
        publicHost: "relay.example.test",
        srtPort: 8890,
        publicWebUrl: "https://relay.example.test",
      }),
    );
  if (req.url?.endsWith("/connection"))
    return res.end(JSON.stringify({ streamKey: "a".repeat(64) }));
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
  const licenseBody = {
    userId: client.id,
    status: "active",
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    maxDevices: 1,
    channelLimit: 2,
  };
  assert.equal((await call(crm, "license-create", licenseBody)).status, 403);
  const issued = await call(admin, "license-create", licenseBody);
  assert.equal(issued.status, 200);
  const key = (await issued.json()).key;
  assert.match(key, /^SD-/);
  assert.equal(
    (
      await call(admin, "assign", {
        userId: client.id,
        channelId: "other-news",
      })
    ).status,
    200,
  );
  const deviceId = "11111111-1111-4111-8111-111111111111";
  const activation = {
    key,
    deviceId,
    label: "Newsroom laptop",
    channelId: "test-news",
  };
  const first = await call(client, "license-activate", activation);
  assert.equal(first.status, 200);
  const profile = (await first.json()).profile;
  assert.equal(profile.channelName, "test-news");
  assert.equal(profile.host, "relay.example.test");
  assert.match(profile.deviceToken, /^[a-f0-9]{64}$/);
  const second = await call(client, "license-activate", {
    ...activation,
    channelId: "other-news",
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).profile.deviceToken, profile.deviceToken);
  assert.equal((await call(other, "license-activate", activation)).status, 403);
  assert.equal(
    (
      await call(client, "license-activate", {
        ...activation,
        deviceId: "22222222-2222-4222-8222-222222222222",
      })
    ).status,
    409,
  );
  const { publicationAllowed } = await import("../server/licenses");
  const publication = (token = profile.deviceToken, channelId = "test-news") =>
    publicationAllowed(
      new Request(origin + "/private/publish", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.RELAY_ADMIN_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channelId, token }),
      }),
    );
  assert.equal((await publication()).status, 204);
  assert.equal((await publication("f".repeat(64))).status, 403);
  assert.equal(
    (await call(admin, "license-update", { ...licenseBody, channelLimit: 1 }))
      .status,
    409,
  );
  assert.equal(
    (
      await call(admin, "license-update", {
        ...licenseBody,
        expiresAt: "2020-01-01T00:00:00Z",
      })
    ).status,
    200,
  );
  assert.equal((await publication()).status, 403);
  assert.equal(
    (await call(client, "license-activate", activation)).status,
    403,
  );
  assert.equal((await call(admin, "license-update", licenseBody)).status, 200);
  assert.equal(
    (
      await call(admin, "license-device-revoke", {
        userId: client.id,
        deviceId,
      })
    ).status,
    200,
  );
  assert.equal((await publication()).status, 403);
  const rotated = await call(admin, "license-rotate", { userId: client.id });
  assert.equal(rotated.status, 200);
  const replacement = (await rotated.json()).key;
  assert.equal(
    (await call(client, "license-activate", activation)).status,
    403,
  );
  const concurrent = await Promise.all(
    [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ].map((deviceId) =>
      call(client, "license-activate", {
        ...activation,
        key: replacement,
        deviceId,
      }),
    ),
  );
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  const visible = await (await call(client, "overview")).json();
  assert.equal(visible.devices.filter((d: any) => !d.revoked).length, 1);
  assert.ok(!JSON.stringify(visible).includes("tokenHash"));
  assert.ok(!JSON.stringify(visible).includes("keyHash"));
  assert.ok(!JSON.stringify(visible).includes(replacement));
  console.log(
    "PASS: license expiry/renewal, device slots under concurrency, multiple channels per device, rotation/revocation, and secret redaction",
  );
} finally {
  await sql.end();
  relay.close();
}
