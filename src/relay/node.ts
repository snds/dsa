import http from "node:http";
import type { RelayHandler } from "./index.js";

/**
 * The relay on plain Node: a Request → Response handler as an http listener. `dsa serve` mounts it
 * under its own server; `dsa relay` runs it alone. Behind a proxy that ends TLS, the relay's public
 * URL (DSA_RELAY_URL) is what browsers see; the listener itself may be plain http on localhost.
 */
export function toNodeListener(handler: RelayHandler, origin: string): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    if (req.method === "POST") {
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 64 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(c as Buffer);
      }
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const request = new Request(new URL(req.url ?? "/", origin), { method: req.method ?? "GET", headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const response = await handler(request);
    const out: Record<string, string | string[]> = {};
    response.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
    const set = response.headers.getSetCookie();
    if (set.length) out["set-cookie"] = set;
    res.writeHead(response.status, out);
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  };
}

/** `dsa relay`: the relay alone on a port. Resolves once it listens. */
export async function startRelayServer(handler: RelayHandler, o: { port: number; host?: string | undefined; publicUrl: string }): Promise<{ url: string; close: () => Promise<void> }> {
  const origin = new URL(o.publicUrl).origin;
  const listener = toNodeListener(handler, origin);
  const server = http.createServer((req, res) => {
    listener(req, res).catch(() => { if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "The relay hit an unexpected error." })); });
  });
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(o.port, o.host ?? "127.0.0.1", () => ok()); });
  return { url: `http://${o.host ?? "127.0.0.1"}:${o.port}`, close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections?.(); }) };
}
