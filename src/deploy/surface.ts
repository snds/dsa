import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { LiveConfig, OpenSurface, SurfaceConfig } from "./types.js";

/**
 * Where a browser sees the live product: the deployed URL itself, or the built folder that gets
 * deployed, served on localhost for the run (a CI job builds it, so it is exactly what ships, and
 * the job needs no access to a private site). Screenshots and Storybook renderings both open one.
 */

/** The live surface for an app: its own entry, else the shorthand for every app. Undefined: not live (started from the checkout). */
export function appSurface(live: LiveConfig | undefined, app: string): SurfaceConfig | undefined {
  return live?.apps?.[app] ?? live?.app;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

/** "/app" → "/app/"; "" → "/". */
export function normalizeBase(base: string | undefined): string {
  const b = `/${(base ?? "/").replace(/^\/+|\/+$/g, "")}/`;
  return b === "//" ? "/" : b;
}

/**
 * Serve a built folder at `base` on 127.0.0.1, the way a static host does: files as they are,
 * `dir/` → `dir/index.html`, and any other path without a file extension → the root index.html
 * (single-page apps route on the client). Nothing outside the folder is ever read.
 */
export function serveStatic(dir: string, base = "/"): Promise<{ url: string; stop: () => void }> {
  const root = path.resolve(dir);
  const mount = normalizeBase(base);
  const server = http.createServer((req, res) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      return res.end();
    }
    if (!pathname.startsWith(mount) && `${pathname}/` !== mount) {
      res.writeHead(404);
      return res.end();
    }
    const rel = pathname.slice(mount.length - 1);
    let file = path.join(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(404);
      return res.end();
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) {
      // A client-side route: hand back the app's shell. A missing asset stays a 404.
      if (path.extname(rel)) {
        res.writeHead(404);
        return res.end();
      }
      file = path.join(root, "index.html");
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        return res.end();
      }
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      ok({
        url: `http://127.0.0.1:${port}${mount}`,
        stop: () => {
          server.close();
          server.closeAllConnections?.();
        },
      });
    });
  });
}

/** Open a surface for one run. A URL is used as it is; a folder is served until `stop`. */
export async function openSurface(s: SurfaceConfig, root: string): Promise<OpenSurface> {
  const storageState = s.auth ? path.resolve(root, s.auth) : undefined;
  if (storageState && !fs.existsSync(storageState)) throw new Error(`The saved sign-in ${s.auth} doesn't exist. Make it once with: dsa login ${s.url ?? "<url>"} --out ${s.auth}`);
  if (s.url) {
    const url = s.url.endsWith("/") || /\.[a-z0-9]+$/i.test(new URL(s.url).pathname) ? s.url : `${s.url}/`;
    return { url, storageState, readApi: s.readApi ?? true, how: `live ${s.url}`, deployed: true, stop: () => {} };
  }
  if (s.dir) {
    const dir = path.resolve(root, s.dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`The built folder ${s.dir} doesn't exist. Build it first (it is what gets deployed).`);
    const served = await serveStatic(dir, s.base);
    return { url: served.url, storageState, readApi: s.readApi ?? false, how: `built folder ${s.dir}`, deployed: false, stop: served.stop };
  }
  throw new Error("A live surface needs `url` or `dir`.");
}
