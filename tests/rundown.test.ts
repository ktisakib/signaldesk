import { test } from "node:test";
import assert from "node:assert/strict";
import {
  moveEntry,
  localDateTime,
  scheduledInstant,
} from "../src/lib/rundown.ts";
test("reorder moves an occurrence without dropping duplicate programs or mutating the queue", () => {
  const queue = [7, 2, 7, 4];
  assert.deepEqual(moveEntry(queue, 2, 0), [7, 7, 2, 4]);
  assert.deepEqual(moveEntry(queue, 0, 3), [2, 7, 4, 7]);
  assert.deepEqual(queue, [7, 2, 7, 4]);
  assert.deepEqual(moveEntry(queue, -1, 2), queue);
  assert.deepEqual(moveEntry(queue, 1, 20), queue);
});
test("scheduled time round trips local time and rejects invalid or past dates", () => {
  const future = new Date(Date.now() + 86400000);
  future.setSeconds(0, 0);
  const input = localDateTime(future.toISOString());
  assert.equal(scheduledInstant(input), future.toISOString());
  assert.throws(() => scheduledInstant(""));
  assert.throws(() => scheduledInstant("2020-01-01T00:00"));
  assert.throws(() => scheduledInstant("garbage"));
  assert.equal(localDateTime("garbage"), "");
});
