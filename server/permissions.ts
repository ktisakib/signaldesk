import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc } from "better-auth/plugins/admin/access";

export const ac = createAccessControl({ ...defaultStatements });
export const roles = {
  admin: ac.newRole(adminAc.statements),
  user: ac.newRole({}),
  support: ac.newRole({}),
  crm: ac.newRole({}),
};
export type Role = keyof typeof roles;
export function permits(
  role: string | null | undefined,
  action: "users" | "subscriptions" | "support" | "channels",
) {
  const assigned = (role ?? "user").split(",");
  return (
    assigned.includes("admin") ||
    (action === "subscriptions" && assigned.includes("crm")) ||
    (action === "support" && assigned.includes("support"))
  );
}
