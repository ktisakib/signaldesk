import {
  pgTable,
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
