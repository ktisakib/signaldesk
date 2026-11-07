import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadMedia } from "../src/lib/api.ts";

test("uploads validate size, send multipart without overriding its boundary, and report server errors", async () => {
  await assert.rejects(uploadMedia(new File([], "empty.mp4")), /nonempty/);
  await assert.rejects(
    uploadMedia({ size: 2 * 1024 ** 3 + 1 } as File),
    /2 GiB/,
  );
  const originalFetch = globalThis.fetch;
  const file = new File(["video"], "program.mp4", { type: "video/mp4" });
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "/api/library/upload");
      assert.equal(init?.method, "POST");
      assert.equal(init?.headers, undefined);
      assert.ok(init?.body instanceof FormData);
      assert.equal((init.body.get("file") as File).name, "program.mp4");
      return new Response(JSON.stringify({ id: 1, title: "program" }));
    };
    assert.equal((await uploadMedia(file)).id, 1);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "Invalid video" }), { status: 400 });
    await assert.rejects(uploadMedia(file), /Invalid video/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
