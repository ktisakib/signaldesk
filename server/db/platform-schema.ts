import {
  pgTable,
  boolean,
  text,
  timestamp,
  integer,
  primaryKey,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
export const subscriptions = pgTable("subscriptions", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  plan: text("plan").notNull().default("Starter"),
  status: text("status").notNull().default("inactive"),
  channelLimit: integer("channel_limit").notNull().default(1),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
export const channelOwners = pgTable("channel_owners", {
  channelId: text("channel_id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
});
export const supportGrants = pgTable(
  "support_grants",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channelOwners.channelId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] })],
);

export const licenses = pgTable("licenses", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  status: text("status").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  maxDevices: integer("max_devices").notNull(),
  channelLimit: integer("channel_limit").notNull(),
});
export const licenseDevices = pgTable(
  "license_devices",
  {
    userId: text("user_id")
      .notNull()
      .references(() => licenses.userId, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    revoked: boolean("revoked").notNull().default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.deviceId] })],
);
