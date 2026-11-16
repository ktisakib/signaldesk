import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
// Schema generation never connects; runtime startup requires a real DATABASE_URL.
export const sql = postgres(
  process.env.DATABASE_URL || "postgres://localhost/signaldesk",
  { max: 5 },
);
export const db = drizzle(sql);
