import { and, eq, sql as sqlQuery } from "drizzle-orm";
import { db } from "./db/client";
import { user } from "./db/auth-schema";
import {
  channelOwners,
  subscriptions,
  supportGrants,
} from "./db/platform-schema";
import { auth } from "./auth";
import { permits } from "./permissions";

export async function control(req: Request): Promise<Response> {
  const fail = (status: number, error: string) =>
    Response.json({ error }, { status });
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return fail(401, "Sign in required");
  const actor = session.user;
  const admin = permits(actor.role, "users");
  const crm = permits(actor.role, "subscriptions");
  const support = permits(actor.role, "support");
  if (
    req.method !== "GET" &&
    req.headers.get("origin") !== new URL(process.env.BETTER_AUTH_URL!).origin
  )
    return fail(403, "Invalid origin");
  const path = new URL(req.url).pathname.replace("/api/control/", "");
  const relay = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(
      new URL(path, process.env.RELAY_INTERNAL_URL || "http://relay:9790"),
      {
        method,
        headers: {
          Authorization: `Bearer ${process.env.RELAY_ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error("Relay operation failed");
    return response.json();
  };
  if (path.startsWith("relay/")) {
    if (!admin) return fail(403, "Administrator access required");
    const target = path.slice("relay".length);
    const allowed =
      (req.method === "GET" &&
        ["/api/channels", "/api/platform", "/api/admin/channels"].includes(
          target,
        )) ||
      (req.method === "POST" &&
        /^\/api\/channels(?:\/[a-z0-9-]+\/rotate)?$/.test(target)) ||
      (req.method === "PUT" &&
        (target === "/api/platform" ||
          /^\/api\/channels\/[a-z0-9-]+$/.test(target))) ||
      (req.method === "DELETE" && /^\/api\/channels\/[a-z0-9-]+$/.test(target));
    if (!allowed) return fail(404, "Unknown relay operation");
    if (req.method === "DELETE") {
      const id = target.split("/").pop()!;
      await relay(target, "DELETE");
      await db.delete(channelOwners).where(eq(channelOwners.channelId, id));
      return Response.json({ ok: true });
    }
    return Response.json(
      await relay(
        target,
        req.method,
        ["POST", "PUT"].includes(req.method) ? await req.json() : undefined,
      ),
    );
  }
  if (path === "overview" && req.method === "GET") {
    const owners = await db.select().from(channelOwners);
    const grants = support
      ? await db
          .select()
          .from(supportGrants)
          .where(eq(supportGrants.userId, actor.id))
      : [];
    const allowed = new Set(
      owners.filter((o) => o.userId === actor.id).map((o) => o.channelId),
    );
    for (const grant of grants) allowed.add(grant.channelId);
    const channels = (await relay("/api/channels")).channels.filter(
      (c: { id: string }) => admin || allowed.has(c.id),
    );
    return Response.json({
      actor: { id: actor.id, name: actor.name, role: actor.role },
      channels,
      owners: owners.filter((o) => admin || allowed.has(o.channelId)),
      clients: crm
        ? await db
            .select({
              id: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
            })
            .from(user)
            .limit(500)
        : [],
      subscriptions: crm
        ? await db.select().from(subscriptions).limit(500)
        : await db
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.userId, actor.id)),
    });
  }
  const body = await req.json();
  if (!body || typeof body !== "object" || Array.isArray(body))
    return fail(400, "Expected an object");
  const validId = (id: unknown): id is string =>
    typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (path === "rename" && req.method === "POST") {
    if (
      !validId(body.channelId) ||
      !name ||
      name.length > 100 ||
      /[\x00-\x1f\x7f]/.test(name)
    )
      return fail(400, "Use a TV channel name of 1–100 characters");
    const [owner] = await db
      .select()
      .from(channelOwners)
      .where(eq(channelOwners.channelId, body.channelId));
    const [grant] = support
      ? await db
          .select()
          .from(supportGrants)
          .where(
            and(
              eq(supportGrants.channelId, body.channelId),
              eq(supportGrants.userId, actor.id),
            ),
          )
      : [];
    if (!admin && !grant) {
      if (owner?.userId !== actor.id) return fail(403, "Channel access denied");
      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, actor.id));
      if (
        !sub ||
        sub.status !== "active" ||
        (sub.expiresAt && sub.expiresAt <= new Date())
      )
        return fail(403, "Active subscription required");
    }
    const channel = (await relay("/api/channels")).channels.find(
      (c: { id: string }) => c.id === body.channelId,
    );
    if (!channel) return fail(404, "Channel not found");
    await relay(`/api/channels/${body.channelId}`, "PUT", {
      name,
      policy: channel.policy,
    });
    return Response.json({ ok: true });
  }
  if (path === "subscription" && req.method === "POST") {
    if (!crm) return fail(403, "Subscription access denied");
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (
      typeof body.userId !== "string" ||
      !["active", "inactive", "suspended"].includes(body.status) ||
      typeof body.plan !== "string" ||
      !body.plan.trim() ||
      body.plan.length > 80 ||
      !Number.isInteger(body.channelLimit) ||
      body.channelLimit < 1 ||
      body.channelLimit > 1000 ||
      (expiresAt && !Number.isFinite(expiresAt.getTime()))
    )
      return fail(400, "Invalid subscription");
    const value = {
      userId: body.userId,
      plan: body.plan.trim(),
      status: body.status,
      channelLimit: body.channelLimit,
      expiresAt,
    };
    await db
      .insert(subscriptions)
      .values(value)
      .onConflictDoUpdate({ target: subscriptions.userId, set: value });
    return Response.json({ ok: true });
  }
  if (!admin) return fail(403, "Administrator access required");
  if (path === "assign" && req.method === "POST") {
    if (!validId(body.channelId) || typeof body.userId !== "string")
      return fail(400, "Invalid assignment");
    if (
      !(await relay("/api/channels")).channels.some(
        (c: { id: string }) => c.id === body.channelId,
      )
    )
      return fail(404, "Channel not found");
    return db.transaction(async (tx) => {
      await tx.execute(
        sqlQuery`LOCK TABLE channel_owners IN SHARE ROW EXCLUSIVE MODE`,
      );
      const [sub] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, body.userId));
      const owned = await tx
        .select()
        .from(channelOwners)
        .where(eq(channelOwners.userId, body.userId));
      if (
        !sub ||
        sub.status !== "active" ||
        (sub.expiresAt && sub.expiresAt <= new Date()) ||
        (owned.length >= sub.channelLimit &&
          !owned.some((c) => c.channelId === body.channelId))
      )
        return fail(409, "Activate subscription or increase channel allowance");
      await tx
        .insert(channelOwners)
        .values({ channelId: body.channelId, userId: body.userId })
        .onConflictDoUpdate({
          target: channelOwners.channelId,
          set: { userId: body.userId },
        });
      // Ownership changes revoke old delegated support access.
      await tx
        .delete(supportGrants)
        .where(eq(supportGrants.channelId, body.channelId));
      return Response.json({ ok: true });
    });
  }
  if (path === "support-grant" && req.method === "POST") {
    if (
      !validId(body.channelId) ||
      typeof body.userId !== "string" ||
      typeof body.enabled !== "boolean"
    )
      return fail(400, "Invalid support grant");
    const [person] = await db
      .select()
      .from(user)
      .where(eq(user.id, body.userId));
    if (!person || !permits(person.role, "support"))
      return fail(400, "Assign the support role first");
    if (body.enabled)
      await db
        .insert(supportGrants)
        .values({ channelId: body.channelId, userId: body.userId })
        .onConflictDoNothing();
    else
      await db
        .delete(supportGrants)
        .where(
          and(
            eq(supportGrants.channelId, body.channelId),
            eq(supportGrants.userId, body.userId),
          ),
        );
    return Response.json({ ok: true });
  }
  return fail(404, "Unknown operation");
}
