import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, gt, or, isNull, sql as sqlQuery } from "drizzle-orm";
import { db } from "./db/client";
import { licenses, licenseDevices, channelOwners } from "./db/platform-schema";
import { user } from "./db/auth-schema";
import { permits } from "./permissions";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const licenseActive = (
  value: { status: string; expiresAt: Date } | undefined,
) => !!value && value.status === "active" && value.expiresAt > new Date();
const fail = (status: number, error: string) =>
  Response.json({ error }, { status });
type Relay = (path: string, method?: string, body?: unknown) => Promise<any>;
const publicFields = {
  userId: licenses.userId,
  keyPrefix: licenses.keyPrefix,
  status: licenses.status,
  expiresAt: licenses.expiresAt,
  maxDevices: licenses.maxDevices,
  channelLimit: licenses.channelLimit,
};
export async function licenseOverview(id: string, admin: boolean) {
  return {
    licenses: await db
      .select(publicFields)
      .from(licenses)
      .where(admin ? undefined : eq(licenses.userId, id))
      .limit(500),
    devices: await db
      .select({
        userId: licenseDevices.userId,
        deviceId: licenseDevices.deviceId,
        label: licenseDevices.label,
        revoked: licenseDevices.revoked,
        activatedAt: licenseDevices.activatedAt,
      })
      .from(licenseDevices)
      .where(admin ? undefined : eq(licenseDevices.userId, id))
      .limit(1000),
  };
}
export async function licenseControl(
  actor: { id: string; role?: string | null },
  path: string,
  body: any,
  relay: Relay,
) {
  const admin = permits(actor.role, "users");
  if (path === "license-activate") {
    if (
      typeof body.key !== "string" ||
      body.key.length > 128 ||
      typeof body.deviceId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        body.deviceId,
      ) ||
      typeof body.label !== "string" ||
      !body.label.trim() ||
      body.label.length > 80 ||
      typeof body.channelId !== "string" ||
      !/^[a-z0-9-]{1,64}$/.test(body.channelId)
    )
      return fail(
        400,
        "Enter the license key, installation ID, device name and channel",
      );
    body.deviceId = body.deviceId.toLowerCase();
    return db.transaction(async (tx) => {
      const [license] = await tx
        .select()
        .from(licenses)
        .where(eq(licenses.userId, actor.id))
        .for("update");
      if (
        !license ||
        !licenseActive(license) ||
        !timingSafeEqual(
          Buffer.from(license.keyHash, "hex"),
          Buffer.from(digest(body.key), "hex"),
        )
      )
        return fail(403, "License invalid, expired or revoked");
      const [owner] = await tx
        .select()
        .from(channelOwners)
        .where(eq(channelOwners.channelId, body.channelId));
      if (owner?.userId !== actor.id)
        return fail(403, "Channel does not belong to this account");
      const devices = await tx
        .select()
        .from(licenseDevices)
        .where(eq(licenseDevices.userId, actor.id));
      const existing = devices.find(
        (d) => d.deviceId === body.deviceId && !d.revoked,
      );
      if (
        !existing &&
        devices.filter((d) => !d.revoked).length >= license.maxDevices
      )
        return fail(
          409,
          "Device limit reached. Ask an administrator to release an unused installation.",
        );
      const token = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
        .update(license.keyHash + ":" + body.deviceId)
        .digest("hex");
      const value = {
        userId: actor.id,
        deviceId: body.deviceId,
        label: body.label.trim(),
        tokenHash: digest(token),
        revoked: false,
        activatedAt: new Date(),
      };
      const platform = await relay("/api/platform");
      const connection = await relay(
        `/api/channels/${body.channelId}/connection`,
      );
      await tx
        .insert(licenseDevices)
        .values(value)
        .onConflictDoUpdate({
          target: [licenseDevices.userId, licenseDevices.deviceId],
          set: value,
        });
      return Response.json({
        profile: {
          format: "signaldesk-connection-v1",
          channelName: body.channelId,
          host: platform.publicHost,
          port: platform.srtPort,
          viewerUrl: platform.publicWebUrl,
          streamKey: connection.streamKey,
          deviceId: body.deviceId,
          deviceToken: token,
        },
      });
    });
  }
  if (!admin) return fail(403, "Only administrators can manage licenses");
  if (typeof body.userId !== "string")
    return fail(400, "Choose a client account");
  if (path === "license-device-revoke") {
    if (typeof body.deviceId !== "string") return fail(400, "Choose a device");
    await db
      .update(licenseDevices)
      .set({ revoked: true })
      .where(
        and(
          eq(licenseDevices.userId, body.userId),
          eq(licenseDevices.deviceId, body.deviceId),
        ),
      );
    return Response.json({ ok: true });
  }
  if (!["license-create", "license-update", "license-rotate"].includes(path))
    return fail(404, "Unknown license operation");
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sqlQuery`LOCK TABLE channel_owners IN SHARE ROW EXCLUSIVE MODE`,
    );
    const [person] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, body.userId))
      .for("update");
    if (!person) return fail(404, "Account not found");
    const [old] = await tx
      .select()
      .from(licenses)
      .where(eq(licenses.userId, body.userId))
      .for("update");
    if (path === "license-create" && old)
      return fail(
        409,
        "This account already has a license. Edit or rotate it.",
      );
    if (path !== "license-create" && !old)
      return fail(404, "License not found");
    let key: string | undefined;
    if (path === "license-create" || path === "license-rotate")
      key = "SD-" + randomBytes(24).toString("hex");
    if (path === "license-rotate") {
      await tx
        .update(licenses)
        .set({ keyHash: digest(key!), keyPrefix: key!.slice(0, 11) })
        .where(eq(licenses.userId, body.userId));
      await tx
        .delete(licenseDevices)
        .where(eq(licenseDevices.userId, body.userId));
    } else {
      const expiresAt =
        typeof body.expiresAt === "string"
          ? new Date(body.expiresAt)
          : new Date(NaN);
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        !Number.isInteger(body.maxDevices) ||
        body.maxDevices < 1 ||
        body.maxDevices > 1000 ||
        !Number.isInteger(body.channelLimit) ||
        body.channelLimit < 1 ||
        body.channelLimit > 1000 ||
        !["active", "revoked"].includes(body.status)
      )
        return fail(
          400,
          "Use an expiry, 1–1000 devices/channels, and active or revoked status",
        );
      const owned = await tx
        .select()
        .from(channelOwners)
        .where(eq(channelOwners.userId, body.userId));
      const devices = await tx
        .select()
        .from(licenseDevices)
        .where(
          and(
            eq(licenseDevices.userId, body.userId),
            eq(licenseDevices.revoked, false),
          ),
        );
      if (owned.length > body.channelLimit || devices.length > body.maxDevices)
        return fail(
          409,
          "Release devices or reassign channels before lowering their limits",
        );
      const fields = {
        expiresAt,
        maxDevices: body.maxDevices,
        channelLimit: body.channelLimit,
        status: body.status,
      };
      if (key)
        await tx.insert(licenses).values({
          userId: body.userId,
          keyHash: digest(key),
          keyPrefix: key.slice(0, 11),
          ...fields,
        });
      else
        await tx
          .update(licenses)
          .set(fields)
          .where(eq(licenses.userId, body.userId));
    }
    // Enable enforcement before committing entitlement changes; partial failures fail closed.
    const ownedChannels = await tx
      .select()
      .from(channelOwners)
      .where(eq(channelOwners.userId, body.userId));
    const relayChannels = (await relay("/api/channels")).channels;
    for (const owner of ownedChannels) {
      const channel = relayChannels.find((c: any) => c.id === owner.channelId);
      if (channel)
        await relay(`/api/channels/${owner.channelId}`, "PUT", {
          name: channel.name,
          policy: { ...channel.policy, licenseRequired: true },
        });
    }
    return Response.json({ ok: true, ...(key ? { key } : {}) });
  });
  return result;
}
export async function publicationAllowed(req: Request) {
  const supplied =
    req.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  if (
    !timingSafeEqual(
      Buffer.from(digest(supplied), "hex"),
      Buffer.from(digest(process.env.RELAY_ADMIN_TOKEN || ""), "hex"),
    )
  )
    return fail(401, "Not authorized");
  const body = await req.json();
  if (
    typeof body.channelId !== "string" ||
    typeof body.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.token)
  )
    return fail(403, "Device activation required");
  const [device] = await db
    .select({ deviceId: licenseDevices.deviceId })
    .from(channelOwners)
    .innerJoin(licenses, eq(licenses.userId, channelOwners.userId))
    .innerJoin(user, eq(user.id, channelOwners.userId))
    .innerJoin(licenseDevices, eq(licenseDevices.userId, channelOwners.userId))
    .where(
      and(
        eq(channelOwners.channelId, body.channelId),
        eq(licenses.status, "active"),
        gt(licenses.expiresAt, new Date()),
        or(eq(user.banned, false), isNull(user.banned)),
        eq(licenseDevices.tokenHash, digest(body.token)),
        eq(licenseDevices.revoked, false),
      ),
    )
    .limit(1);
  return device
    ? new Response(null, { status: 204 })
    : fail(403, "License or device unavailable");
}
