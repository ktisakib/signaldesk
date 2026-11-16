import { test } from "node:test";
import assert from "node:assert/strict";
import { permits } from "../server/permissions.ts";
test("only administrators can manage users or bypass channel scoping", () => {
  for (const role of ["user", "support", "crm", "unknown", null]) {
    assert.equal(permits(role, "users"), false);
    assert.equal(permits(role, "channels"), false);
  }
  assert.equal(permits("admin", "users"), true);
});
test("CRM and support permissions remain separate, with explicit multi-role grants", () => {
  assert.equal(permits("crm", "subscriptions"), true);
  assert.equal(permits("support", "subscriptions"), false);
  assert.equal(permits("crm", "support"), false);
  assert.equal(permits("support", "support"), true);
  assert.equal(permits("crm,support", "subscriptions"), true);
  assert.equal(permits("crm,support", "support"), true);
});
