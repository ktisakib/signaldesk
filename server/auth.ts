import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { db } from "./db/client";
import * as schema from "./db/auth-schema";
import { ac, roles } from "./permissions";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
  },
  plugins: [admin({ ac, roles, defaultRole: "user", adminRoles: ["admin"] })],
  rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
});
