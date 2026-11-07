import { test } from "node:test";
import assert from "node:assert/strict";
import { readRelayProfile } from "../src/lib/relay.ts";

test("connection profiles retain only known fields and require a version and port", () => {
  const fields = {
    channelName: "news-a",
    host: "192.168.0.248",
    port: 8890,
    viewerUrl: "http://192.168.0.248:18088",
    streamKey: "test-key-12345678",
  };
  const profile = {
    ...fields,
    format: "signaldesk-connection-v1",
    unexpected: "ignored",
  };
  assert.deepEqual(readRelayProfile(JSON.stringify(profile)), fields);
  for (const bad of [
    null,
    {},
    { ...profile, port: 0 },
    { ...profile, port: "8890" },
    { ...profile, streamKey: {} },
    { ...profile, format: "other" },
  ]) {
    assert.throws(() => readRelayProfile(JSON.stringify(bad)));
  }
  assert.throws(() => readRelayProfile(" ".repeat(8193)));
});
