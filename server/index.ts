import { createServer } from "node:http";
import { toNodeHandler } from "better-auth/node";
const ready =
  !!process.env.DATABASE_URL &&
  !!process.env.BETTER_AUTH_URL &&
  (process.env.BETTER_AUTH_SECRET?.length ?? 0) >= 32 &&
  !!process.env.RELAY_ADMIN_TOKEN;
const services = ready
  ? await Promise.all([
      import("./auth"),
      import("./control"),
      import("./licenses"),
    ])
  : null;
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const send = (status: number, error: string) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  };
  if (!services)
    return send(503, "Account service awaits database configuration");
  if (req.url?.startsWith("/api/auth/"))
    return toNodeHandler(services[0].auth)(req, res);
  const privateLicense = req.url === "/private/publish";
  if (!privateLicense && !req.url?.startsWith("/api/control/"))
    return send(404, "Not found");
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) return send(413, "Request too large");
      chunks.push(Buffer.from(chunk));
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    const request = new Request(
      new URL(req.url!, process.env.BETTER_AUTH_URL),
      {
        method: req.method,
        headers,
        ...(size ? { body: Buffer.concat(chunks) } : {}),
      },
    );
    const response = privateLicense
      ? await services[2].publicationAllowed(request)
      : await services[1].control(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) {
    send(
      error instanceof SyntaxError ? 400 : 503,
      error instanceof SyntaxError
        ? "Invalid JSON"
        : "Account operation unavailable",
    );
  }
});
server.requestTimeout = 15000;
server.listen(
  Number(process.env.ACCOUNTS_PORT || 9792),
  process.env.ACCOUNTS_BIND || "127.0.0.1",
);
