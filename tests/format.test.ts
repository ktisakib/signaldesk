import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bytes,
  duration,
  queueOffsets,
  viewerCapacity,
} from "../src/lib/format.ts";

test("duration handles hour boundaries and invalid values", () => {
  assert.equal(duration(59.9), "0:59");
  assert.equal(duration(3605), "1:00:05");
  assert.equal(duration(-1), "0:00");
  assert.equal(duration(Number.NaN), "0:00");
});
test("upload estimate reserves headroom and includes audio", () => {
  assert.equal(viewerCapacity(20, 4000), 3);
  assert.equal(viewerCapacity(20, 2500), 4);
  assert.equal(viewerCapacity(100, 2500), 24);
  assert.equal(viewerCapacity(0, 4000), 0);
  assert.equal(viewerCapacity(20, 0), 0);
});
test("timeline offsets follow saved queue order", () => {
  assert.deepEqual(
    queueOffsets([
      { durationSeconds: 30 },
      { durationSeconds: 60 },
      { durationSeconds: 10 },
    ]),
    [0, 30, 90],
  );
  assert.deepEqual(queueOffsets([]), []);
  assert.equal(bytes(1024 ** 3), "1.0 GB");
});
