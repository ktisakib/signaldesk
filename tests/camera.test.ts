import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cameraMimeType,
  cameraSocketUrl,
  publishCamera,
} from "../src/lib/camera.ts";

test("camera negotiation supports WebM and MP4 and restricts sessions to local control", () => {
  assert.equal(
    cameraMimeType((type) => type === "video/mp4"),
    "video/mp4",
  );
  assert.equal(
    cameraMimeType(() => true),
    "video/webm;codecs=vp8,opus",
  );
  assert.throws(() => cameraMimeType(() => false), /cannot encode/);
  assert.equal(
    cameraSocketUrl("/api/camera/stream/abc-123", "http://localhost:8080"),
    "ws://localhost:8080/api/camera/stream/abc-123",
  );
  for (const [path, origin] of [
    ["//other.example/camera", "http://localhost:8080"],
    ["/api/camera/stream/a?key=b", "http://localhost:8080"],
    ["/api/camera/stream/a", "https://other.example"],
  ])
    assert.throws(() => cameraSocketUrl(path, origin));
});

test("camera waits for engine readiness and stops bounded uploads when acknowledgements fall behind", async () => {
  const originals = {
    MediaRecorder: globalThis.MediaRecorder,
    WebSocket: globalThis.WebSocket,
  };
  const recorders: FakeRecorder[] = [];
  const sockets: FakeSocket[] = [];
  class FakeRecorder {
    state = "inactive";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    constructor() {
      recorders.push(this);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.onstop?.();
    }
  }
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    closed = false;
    sent: Blob[] = [];
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() {
      sockets.push(this);
    }
    send(data: Blob) {
      this.sent.push(data);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
  }
  try {
    globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    let failure = "";
    const connecting = publishCamera(
      {} as MediaStream,
      "video/webm",
      "ws://localhost:8080/api/camera/stream/test",
      (message) => {
        failure = message;
      },
    );
    const recorder = recorders[0];
    const socket = sockets[0];
    assert.equal(recorder.state, "inactive");
    socket.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
    const publisher = await connecting;
    assert.equal(recorder!.state, "recording");
    recorder!.ondataavailable?.({ data: new Blob([new Uint8Array(1024)]) });
    socket!.onmessage?.({ data: JSON.stringify({ type: "ack", bytes: 1024 }) });
    assert.equal(socket!.sent.length, 1);
    recorder!.ondataavailable?.({
      data: new Blob([new Uint8Array(8 * 1024 ** 2 + 1)]),
    });
    assert.match(failure, /cannot keep up/);
    assert.equal(recorder!.state, "inactive");
    assert.ok(socket!.closed);
    publisher.stop();
  } finally {
    Object.assign(globalThis, originals);
  }
});
