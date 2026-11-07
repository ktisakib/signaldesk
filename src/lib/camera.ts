export function cameraMimeType(supported: (type: string) => boolean): string {
  const type = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
    "video/mp4",
  ].find(supported);
  if (!type)
    throw new Error(
      "This browser cannot encode a live camera. Try Chrome or Edge.",
    );
  return type;
}

export function cameraSocketUrl(path: string, origin: string): string {
  if (!/^\/api\/camera\/stream\/[a-zA-Z0-9-]+$/.test(path))
    throw new Error("Invalid camera session address.");
  const url = new URL(path, origin);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("Camera capture must connect to the local studio.");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function publishCamera(
  stream: MediaStream,
  mimeType: string,
  address: string,
  onFailure: (message: string) => void,
): Promise<{ stop: () => void }> {
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 3_000_000,
    audioBitsPerSecond: 128_000,
  });
  const socket = new WebSocket(address);
  return new Promise((resolve, reject) => {
    let stopped = false;
    let ready = false;
    let sent = 0;
    let acknowledged = 0;
    const timer = setTimeout(
      () => fail("Camera connection timed out. Check the local engine."),
      15_000,
    );
    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      if (recorder.state !== "inactive") recorder.stop();
      socket.close();
    }
    function fail(message: string) {
      if (stopped) return;
      stop();
      if (ready) onFailure(message);
      else reject(new Error(message));
    }
    socket.onmessage = (event) => {
      if (stopped) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "ready" && !ready) {
          recorder.start(500);
          ready = true;
          clearTimeout(timer);
          resolve({ stop });
        } else if (message.type === "ack") {
          if (
            !Number.isSafeInteger(message.bytes) ||
            message.bytes < 0 ||
            acknowledged + message.bytes > sent
          )
            throw new Error("Invalid camera acknowledgement.");
          acknowledged += message.bytes;
        } else if (message.type === "error") {
          fail(
            "The camera input stopped. Check the engine log and queue status.",
          );
        }
      } catch {
        fail("The engine could not start camera capture.");
      }
    };
    recorder.ondataavailable = (event) => {
      if (stopped || event.data.size === 0) return;
      if (socket.readyState !== WebSocket.OPEN) {
        fail(
          "The camera connection closed. Check the queue status before reconnecting.",
        );
        return;
      }
      const limit = 8 * 1024 ** 2;
      if (
        sent - acknowledged + event.data.size > limit ||
        socket.bufferedAmount > limit
      ) {
        fail(
          "Camera upload cannot keep up. Close other heavy apps, then preview and reconnect.",
        );
        return;
      }
      try {
        socket.send(event.data);
        sent += event.data.size;
      } catch {
        fail("The camera connection was interrupted.");
      }
    };
    recorder.onerror = () =>
      fail("The browser camera encoder stopped. Preview the camera again.");
    recorder.onstop = () => {
      if (!stopped) fail("Camera capture ended.");
    };
    socket.onerror = () =>
      fail("Cannot connect the camera to the local engine.");
    socket.onclose = () =>
      fail(
        "Camera input ended. The saved queue returns if fallback is enabled.",
      );
  });
}
