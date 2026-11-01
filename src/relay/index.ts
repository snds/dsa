// The scan relay: one handler, standard Request → Response (Web Fetch API), so it runs on any host
// that speaks it: `dsa serve` and `dsa relay` (Node), a serverless function, a worker. It holds the
// runner credential (an environment secret) and starts scans for signed-in viewers, so a published
// dashboard can re-scan without a token of the viewer's own. Nothing here imports Node.
//
// Endpoints, under the relay's own URL (publicUrl):
//   GET  auth/start?return=<page>   sign in with the identity provider (GitHub), then back to <page>
//   GET  auth/callback              the provider sends the viewer back here
//   POST auth/sign-out
//   GET  session                    who is signed in and whether they may scan
//   POST scan                       start a scan (409 with the running one if one is going)
//   GET  scan/status?id=            where one run stands
//   GET  scan/active                runs going now, and how long a scan usually takes
//
// Viewer sessions are HMAC-signed and short-lived. They travel as an HttpOnly, Secure cookie (same-site
// hosting) and as a bearer token the page keeps in sessionStorage (browsers that block third-party
// cookies). Neither is a provider token: the viewer's GitHub token is used once to learn who they are
// and then dropped.

import type { RunnerSpec } from "../deploy/types.js";
import { RunnerError, runnerFor, type ScanRun, type ScanRunner } from "./runners.js";

export * from "./runners.js";

export type Permission = "none" | "read" | "triage" | "write" | "maintain" | "admin";
export const PERMISSIONS: Permission[] = ["none", "read", "triage", "write", "maintain", "admin"];
export const atLeast = (have: Permission, want: Permission) => PERMISSIONS.indexOf(have) >= PERMISSIONS.indexOf(want);

/** Who the viewer is, and what they may do on the scanned repo. */
export interface IdentityProvider {
  id: string;
  /** "GitHub", for "Sign in with GitHub". */
  label: string;
  /** The repo whose access decides who may scan, for messages. */
  resource: string;
  authorizeUrl(state: string, redirectUri: string): string;
  /** Exchange the code from the callback; the provider token is not kept. */
  finish(code: string, redirectUri: string): Promise<{ login: string; permission: Permission }>;
  /** The viewer's access now, with the relay's own credential (so a removed collaborator can't keep scanning). Null: can't tell, keep the session's. */
  recheck?(login: string): Promise<Permission | null>;
}

export interface RelayOptions {
  runner: ScanRunner;
  identity: IdentityProvider;
  /** Signs sessions. At least 32 characters; rotate it to sign everyone out. */
  sessionSecret: string;
  /** The relay's own address, as browsers reach it, including any sub-path (https://relay.example.com/, https://example.com/dsa/relay/). */
  publicUrl: string;
  /** Dashboard origins allowed to call the relay and to be returned to after sign-in (https://example.github.io). */
  origins: string[];
  /** Least access on the repo that may start a scan (default write). */
  minPermission?: Permission;
  /** How long a sign-in lasts (default 8 hours). */
  sessionSeconds?: number;
  /** Scans one viewer may start per window (default 3 per 10 minutes). Kept in memory, per relay instance. */
  rateLimit?: { max: number; windowSeconds: number };
  /** Who may read run progress: anyone who can reach the relay (without run links), or signed-in viewers only. Default public. */
  statusAccess?: "public" | "signed-in";
  /** SameSite for the session cookie. None (default) works when the dashboard is on another site; Lax or Strict when it shares one. */
  cookieSameSite?: "None" | "Lax" | "Strict";
  now?: () => number;
  log?: (m: string) => void;
}

export type RelayHandler = (req: Request) => Promise<Response>;

// ── Signing ─────────────────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** A signed, expiring token: v1.<payload>.<signature>. `kind` keeps a sign-in state from passing as a session. */
export async function sign(secret: string, kind: string, payload: Record<string, unknown>, expiresAt: number): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, k: kind, exp: Math.floor(expiresAt / 1000) })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`v1.${body}`)));
  return `v1.${body}.${b64url(sig)}`;
}

/** The payload of a token this secret signed, for this kind, not yet expired; otherwise null. */
export async function verify(secret: string, kind: string, token: string | null | undefined, now: number): Promise<Record<string, any> | null> {
  const m = token?.match(/^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64url(m[2]!), enc.encode(`v1.${m[1]}`));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64url(m[1]!)));
    return p?.k === kind && typeof p.exp === "number" && p.exp * 1000 > now ? p : null;
  } catch {
    return null;
  }
}

const nonce = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

// ── GitHub sign-in ──────────────────────────────────────────────────────────────────────────────

export interface GithubIdentityOptions {
  clientId: string;
  clientSecret: string;
  /** owner/name: the viewer's access to it decides who may scan. */
  repo: string;
  server?: string;
  api?: string;
  /** A token of the relay's that can read the repo's collaborators (the runner token usually can). Without it, access is read once with the viewer's token at sign-in. */
  checkToken?: string | null;
  fetch?: typeof fetch;
}

/** Sign in with GitHub through the OAuth web flow (a GitHub App's or an OAuth App's client; no scopes asked). */
export function githubIdentity(o: GithubIdentityOptions): IdentityProvider {
  const f = o.fetch ?? fetch;
  const server = (o.server ?? "https://github.com").replace(/\/+$/, "");
  const api = (o.api ?? (server === "https://github.com" ? "https://api.github.com" : `${server}/api/v3`)).replace(/\/+$/, "");
  const headers = (t: string) => ({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${t}` });
  const level = (j: any): Permission => {
    const r = String(j?.role_name ?? j?.permission ?? "none");
    return (PERMISSIONS as string[]).includes(r) ? (r as Permission) : r === "pull" ? "read" : r === "push" ? "write" : "none";
  };
  /** The viewer's access with the relay's token: GET /repos/{repo}/collaborators/{login}/permission. */
  const byRelay = async (login: string): Promise<Permission | null> => {
    if (!o.checkToken) return null;
    const r = await f(`${api}/repos/${o.repo}/collaborators/${encodeURIComponent(login)}/permission`, { headers: headers(o.checkToken) });
    if (r.status === 404) return "none";
    if (!r.ok) throw new Error(`GitHub answered ${r.status} when the relay checked ${login}'s access to ${o.repo}.`);
    return level(await r.json());
  };
  /** The viewer's access with their own token: GET /repos/{repo} → permissions. */
  const byViewer = async (token: string): Promise<Permission> => {
    const r = await f(`${api}/repos/${o.repo}`, { headers: headers(token) });
    if (!r.ok) return "none";
    const p = ((await r.json()) as any)?.permissions ?? {};
    return p.admin ? "admin" : p.maintain ? "maintain" : p.push ? "write" : p.triage ? "triage" : p.pull ? "read" : "none";
  };
  return {
    id: "github",
    label: "GitHub",
    resource: o.repo,
    authorizeUrl: (state, redirectUri) => `${server}/login/oauth/authorize?${new URLSearchParams({ client_id: o.clientId, redirect_uri: redirectUri, state, allow_signup: "false" })}`,
    async finish(code, redirectUri) {
      const t = await f(`${server}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: o.clientId, client_secret: o.clientSecret, code, redirect_uri: redirectUri }),
      });
      const tj: any = await t.json().catch(() => ({}));
      if (!t.ok || !tj.access_token) throw new Error(`GitHub didn't complete the sign-in${tj.error_description ? `: ${tj.error_description}` : tj.error ? `: ${tj.error}` : ""}.`);
      const u = await f(`${api}/user`, { headers: headers(tj.access_token) });
      if (!u.ok) throw new Error(`GitHub answered ${u.status} when asked who signed in.`);
      const login = String(((await u.json()) as any).login ?? "");
      if (!login) throw new Error("GitHub didn't say who signed in.");
      const permission = (await byRelay(login)) ?? (await byViewer(tj.access_token));
      return { login, permission };
    },
    recheck: (login) => byRelay(login),
  };
}

// ── The handler ─────────────────────────────────────────────────────────────────────────────────

const SESSION_COOKIE = "dsa_relay";
const STATE_COOKIE = "dsa_relay_state";

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const originOf = (u: string) => { try { return new URL(u).origin; } catch { return null; } };

export function createRelay(o: RelayOptions): RelayHandler {
  if (!o.sessionSecret || o.sessionSecret.length < 32) throw new Error("The relay's session secret must be at least 32 characters (DSA_RELAY_SESSION_SECRET).");
  const self = new URL(o.publicUrl.endsWith("/") ? o.publicUrl : `${o.publicUrl}/`);
  const base = self.pathname; // ends with "/"
  const callback = new URL("auth/callback", self).toString();
  const origins = new Set(o.origins.map(originOf).filter((x): x is string => Boolean(x)));
  origins.add(self.origin);
  const min = o.minPermission ?? "write";
  const ttl = (o.sessionSeconds ?? 8 * 3600) * 1000;
  const limit = o.rateLimit ?? { max: 3, windowSeconds: 600 };
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? (() => {});
  const sameSite = o.cookieSameSite ?? "None";
  const secureCookie = self.protocol === "https:" || self.hostname === "localhost" || self.hostname === "127.0.0.1";
  const cookie = (name: string, value: string, maxAge: number, site = sameSite) => `${name}=${encodeURIComponent(value)}; Path=${base}; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; SameSite=${site}${secureCookie || site === "None" ? "; Secure" : ""}`;

  const starts = new Map<string, number[]>();
  let starting: Promise<unknown> | null = null;
  // Many viewers poll; GitHub's API allowance is the relay's. Answers are reused for a few seconds.
  const cache = new Map<string, { at: number; value: unknown }>();
  async function cached<T>(key: string, ms: number, get: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ms) return hit.value as T;
    const value = await get();
    cache.set(key, { at: now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return value;
  }
  const forget = () => cache.clear();

  function cors(req: Request): Record<string, string> {
    const origin = req.headers.get("origin");
    return origin && origins.has(origin)
      ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-DSA-Relay", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "600", Vary: "Origin" }
      : { Vary: "Origin" };
  }
  const json = (req: Request, status: number, body: unknown, extra: Record<string, string> = {}, setCookies: string[] = []) => {
    const h = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...cors(req), ...extra });
    for (const c of setCookies) h.append("Set-Cookie", c);
    return new Response(JSON.stringify(body), { status, headers: h });
  };
  const redirect = (to: string, setCookies: string[] = []) => {
    const h = new Headers({ Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    for (const c of setCookies) h.append("Set-Cookie", c);
    return new Response(null, { status: 302, headers: h });
  };
  /** Back to the page, with the session (or the error) in the fragment, which never reaches a server. */
  const back = (page: string, key: string, value: string, setCookies: string[] = []) => {
    const u = new URL(page);
    u.hash = `${key}=${encodeURIComponent(value)}`;
    return redirect(u.toString(), setCookies);
  };

  async function session(req: Request): Promise<{ login: string; permission: Permission } | null> {
    const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const p = (await verify(o.sessionSecret, "session", bearer, now())) ?? (await verify(o.sessionSecret, "session", cookies(req)[SESSION_COOKIE], now()));
    return p && typeof p.sub === "string" ? { login: p.sub, permission: (PERMISSIONS as string[]).includes(p.perm) ? p.perm : "none" } : null;
  }

  /** A call that changes something comes from an allowed page and carries the relay's header (which forces a CORS preflight). */
  const fromAllowedPage = (req: Request) => {
    const origin = req.headers.get("origin");
    return Boolean(origin && origins.has(origin) && req.headers.get("x-dsa-relay") === "1");
  };

  const signInUrl = (page?: string | null) => `${new URL("auth/start", self)}${page ? `?return=${encodeURIComponent(page)}` : ""}`;
  const view = (run: ScanRun, full: boolean): ScanRun => (full ? run : { ...run, url: null });
  const failure = (req: Request, e: unknown) => {
    const err = e instanceof RunnerError ? e : null;
    log(`Relay: ${e instanceof Error ? e.message : String(e)}`);
    return json(req, err?.kind === "not-found" ? 404 : 502, { error: e instanceof Error ? e.message : "The relay hit an unexpected error.", url: err?.url ?? null });
  };

  return async function relay(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(base) && url.pathname !== base.slice(0, -1)) return json(req, 404, { error: "Not found." });
    const route = url.pathname.slice(base.length);
    const m = req.method.toUpperCase();
    try {
      if (m === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });

      if (m === "GET" && route === "auth/start") {
        const page = url.searchParams.get("return") ?? "";
        const po = originOf(page);
        if (!po || !origins.has(po)) return json(req, 400, { error: "Sign-in can only return to the dashboard this relay serves." });
        const n = nonce();
        const state = await sign(o.sessionSecret, "state", { n, r: page.split("#")[0] }, now() + 10 * 60_000);
        return redirect(o.identity.authorizeUrl(state, callback), [cookie(STATE_COOKIE, n, 600, "Lax")]);
      }

      if (m === "GET" && route === "auth/callback") {
        const st = await verify(o.sessionSecret, "state", url.searchParams.get("state"), now());
        const clear = cookie(STATE_COOKIE, "", 0, "Lax");
        // The state names the page and must match this browser's own sign-in (login CSRF).
        if (!st || typeof st.r !== "string" || st.n !== cookies(req)[STATE_COOKIE]) return json(req, 400, { error: "This sign-in link expired or came from another browser. Start again from the dashboard." }, {}, [clear]);
        const code = url.searchParams.get("code");
        if (!code) return back(st.r, "dsa-relay-error", url.searchParams.get("error_description") ?? "Sign-in was cancelled.", [clear]);
        let who: { login: string; permission: Permission };
        try {
          who = await o.identity.finish(code, callback);
        } catch (e) {
          return back(st.r, "dsa-relay-error", e instanceof Error ? e.message : "Sign-in failed.", [clear]);
        }
        if (!atLeast(who.permission, min)) {
          log(`Relay: ${who.login} signed in with ${who.permission} access; scans need ${min}.`);
          return back(st.r, "dsa-relay-error", `Signed in as ${who.login}, who has ${who.permission} access to ${o.identity.resource}. Re-scan needs ${min} access.`, [clear]);
        }
        const token = await sign(o.sessionSecret, "session", { sub: who.login, perm: who.permission }, now() + ttl);
        log(`Relay: ${who.login} signed in (${who.permission}).`);
        return back(st.r, "dsa-relay", token, [clear, cookie(SESSION_COOKIE, token, ttl / 1000)]);
      }

      if (m === "POST" && route === "auth/sign-out") {
        if (!fromAllowedPage(req)) return json(req, 403, { error: "Sign-out must come from the dashboard." });
        return json(req, 200, { signedIn: false }, {}, [cookie(SESSION_COOKIE, "", 0)]);
      }

      if (m === "GET" && route === "session") {
        const s = await session(req);
        return json(req, 200, { signedIn: Boolean(s), login: s?.login ?? null, permission: s?.permission ?? null, canScan: Boolean(s && atLeast(s.permission, min)), minPermission: min, provider: o.identity.label, resource: o.identity.resource, signIn: signInUrl() });
      }

      if (m === "POST" && route === "scan") {
        if (!fromAllowedPage(req)) return json(req, 403, { error: "Scans can only be started from the dashboard this relay serves." });
        const s = await session(req);
        if (!s) return json(req, 401, { error: `Sign in with ${o.identity.label} to re-scan.`, signIn: signInUrl() });
        let perm = s.permission;
        try {
          perm = (await o.identity.recheck?.(s.login)) ?? perm;
        } catch (e) {
          log(`Relay: couldn't re-check ${s.login}'s access: ${e instanceof Error ? e.message : e}`);
        }
        if (!atLeast(perm, min)) return json(req, 403, { error: `${s.login} has ${perm} access to ${o.identity.resource}. Re-scan needs ${min} access.` });
        const recent = (starts.get(s.login) ?? []).filter((t) => now() - t < limit.windowSeconds * 1000);
        if (recent.length >= limit.max) {
          const wait = Math.ceil((recent[0]! + limit.windowSeconds * 1000 - now()) / 1000);
          return json(req, 429, { error: `You've started ${limit.max} scans in the last ${Math.round(limit.windowSeconds / 60)} minutes. Try again in ${Math.ceil(wait / 60)} minute${Math.ceil(wait / 60) === 1 ? "" : "s"}.` }, { "Retry-After": String(wait) });
        }
        // One scan at a time: a second press, a teammate or a scheduled run gets the one going.
        if (starting) return json(req, 409, { error: "A scan is starting. Try again in a moment.", run: null });
        const go = (async () => {
          const [running] = await o.runner.listActive();
          if (running) return { running };
          const run = await o.runner.trigger();
          return { run };
        })();
        starting = go;
        try {
          const r = await go;
          forget();
          if ("running" in r && r.running) return json(req, 409, { error: "A scan is already running.", run: r.running });
          starts.set(s.login, [...recent, now()]);
          log(`Relay: ${s.login} started scan ${r.run!.id}.`);
          return json(req, 202, { run: r.run });
        } finally {
          starting = null;
        }
      }

      if (m === "GET" && (route === "scan/status" || route === "scan/active")) {
        const s = await session(req);
        if ((o.statusAccess ?? "public") === "signed-in" && !s) return json(req, 401, { error: `Sign in with ${o.identity.label} to see scans.`, signIn: signInUrl() });
        if (route === "scan/status") {
          const id = url.searchParams.get("id") ?? "";
          if (!/^[\w.-]{1,100}$/.test(id)) return json(req, 400, { error: "That isn't a run id." });
          return json(req, 200, { run: view(await cached(`status:${id}`, 4000, () => o.runner.status(id)), Boolean(s)) });
        }
        const runs = await cached("active", 10_000, () => o.runner.listActive());
        const estimate = await cached("estimate", 10 * 60_000, async () => (await o.runner.estimate?.().catch(() => null)) ?? null);
        return json(req, 200, { runs: runs.map((r) => view(r, Boolean(s))), estimate });
      }

      return json(req, 404, { error: "Not found." });
    } catch (e) {
      return failure(req, e);
    }
  };
}

// ── From the environment: what a serverless host or `dsa relay` sets ────────────────────────────

/** The settings a relay reads, by name. Values are secrets or addresses; none is ever logged or sent to the page. */
export const RELAY_ENV = {
  required: ["DSA_RELAY_URL", "DSA_RELAY_ORIGINS", "DSA_RELAY_SESSION_SECRET", "DSA_RELAY_CLIENT_ID", "DSA_RELAY_CLIENT_SECRET", "DSA_RELAY_REPO"],
  optional: [
    "DSA_RELAY_RUNNER",
    "DSA_RELAY_RUNNER_TOKEN",
    "DSA_RELAY_WORKFLOW",
    "DSA_RELAY_REF",
    "DSA_RELAY_WEBHOOK_TRIGGER",
    "DSA_RELAY_WEBHOOK_STATUS",
    "DSA_RELAY_WEBHOOK_ACTIVE",
    "DSA_RELAY_GITHUB_SERVER",
    "DSA_RELAY_GITHUB_API",
    "DSA_RELAY_PERMISSION_TOKEN",
    "DSA_RELAY_MIN_PERMISSION",
    "DSA_RELAY_SESSION_HOURS",
    "DSA_RELAY_RATE",
    "DSA_RELAY_STATUS",
    "DSA_RELAY_COOKIE_SAMESITE",
  ],
} as const;

type Env = Record<string, string | undefined>;

/** What's missing or wrong in these settings, by name (never by value). Empty: ready. */
export function relayEnvProblems(env: Env): string[] {
  const out: string[] = [];
  for (const k of RELAY_ENV.required) if (!env[k]?.trim()) out.push(`${k} is not set.`);
  const runner = env.DSA_RELAY_RUNNER?.trim() || "github";
  if (runner === "github" && !env.DSA_RELAY_RUNNER_TOKEN?.trim()) out.push("DSA_RELAY_RUNNER_TOKEN is not set (the github runner needs it).");
  if (runner === "webhook" && !env.DSA_RELAY_WEBHOOK_TRIGGER?.trim()) out.push("DSA_RELAY_WEBHOOK_TRIGGER is not set (the webhook runner needs it).");
  if (runner !== "github" && runner !== "webhook") out.push(`DSA_RELAY_RUNNER is "${runner}"; the built-in runners are github and webhook.`);
  if (env.DSA_RELAY_SESSION_SECRET && env.DSA_RELAY_SESSION_SECRET.length < 32) out.push("DSA_RELAY_SESSION_SECRET is shorter than 32 characters.");
  if (env.DSA_RELAY_MIN_PERMISSION && !(PERMISSIONS as string[]).includes(env.DSA_RELAY_MIN_PERMISSION)) out.push(`DSA_RELAY_MIN_PERMISSION must be one of ${PERMISSIONS.join(", ")}.`);
  if (env.DSA_RELAY_RATE && !/^\d+\/\d+$/.test(env.DSA_RELAY_RATE)) out.push('DSA_RELAY_RATE must look like "3/600" (scans per seconds).');
  if (env.DSA_RELAY_REPO && !/^[\w.-]+\/[\w.-]+$/.test(env.DSA_RELAY_REPO)) out.push('DSA_RELAY_REPO must be "owner/name".');
  for (const k of ["DSA_RELAY_URL"] as const) if (env[k] && !originOf(env[k]!)) out.push(`${k} isn't a URL.`);
  for (const o of (env.DSA_RELAY_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) if (!originOf(o)) out.push(`DSA_RELAY_ORIGINS has "${o}", which isn't an origin (https://host).`);
  return out;
}

/** The relay these settings describe. Throws with every problem at once when they're incomplete. */
export function relayOptionsFromEnv(env: Env, extra: { fetch?: typeof fetch; log?: (m: string) => void; runner?: ScanRunner } = {}): RelayOptions {
  const problems = relayEnvProblems(env);
  if (problems.length) throw new Error(`The relay isn't configured:\n- ${problems.join("\n- ")}`);
  const f = extra.fetch ?? fetch;
  const server = (env.DSA_RELAY_GITHUB_SERVER?.trim() || "https://github.com").replace(/\/+$/, "");
  const api = (env.DSA_RELAY_GITHUB_API?.trim() || (server === "https://github.com" ? "https://api.github.com" : `${server}/api/v3`)).replace(/\/+$/, "");
  const repo = env.DSA_RELAY_REPO!.trim();
  const kind = env.DSA_RELAY_RUNNER?.trim() || "github";
  const credential = env.DSA_RELAY_RUNNER_TOKEN?.trim() || null;
  const spec: RunnerSpec =
    kind === "webhook"
      ? { type: "webhook", trigger: env.DSA_RELAY_WEBHOOK_TRIGGER!.trim(), status: env.DSA_RELAY_WEBHOOK_STATUS?.trim() || undefined, active: env.DSA_RELAY_WEBHOOK_ACTIVE?.trim() || undefined }
      : { type: "github", api, server, repo, workflow: env.DSA_RELAY_WORKFLOW?.trim() || "dsa.yml", ref: env.DSA_RELAY_REF?.trim() || undefined };
  const [max, win] = (env.DSA_RELAY_RATE ?? "3/600").split("/").map(Number);
  const opts: RelayOptions = {
    runner: extra.runner ?? runnerFor(spec, credential, f),
    identity: githubIdentity({ clientId: env.DSA_RELAY_CLIENT_ID!.trim(), clientSecret: env.DSA_RELAY_CLIENT_SECRET!.trim(), repo, server, api, checkToken: env.DSA_RELAY_PERMISSION_TOKEN?.trim() || (kind === "github" ? credential : null), fetch: f }),
    sessionSecret: env.DSA_RELAY_SESSION_SECRET!,
    publicUrl: env.DSA_RELAY_URL!.trim(),
    origins: env.DSA_RELAY_ORIGINS!.split(",").map((x) => x.trim()).filter(Boolean),
    minPermission: (env.DSA_RELAY_MIN_PERMISSION?.trim() as Permission) || "write",
    sessionSeconds: Number(env.DSA_RELAY_SESSION_HOURS || 8) * 3600,
    rateLimit: { max: max!, windowSeconds: win! },
    statusAccess: env.DSA_RELAY_STATUS === "signed-in" ? "signed-in" : "public",
    cookieSameSite: env.DSA_RELAY_COOKIE_SAMESITE === "Lax" || env.DSA_RELAY_COOKIE_SAMESITE === "Strict" ? env.DSA_RELAY_COOKIE_SAMESITE : "None",
  };
  if (extra.log) opts.log = extra.log;
  return opts;
}

/**
 * A relay from the environment, for hosts that hand over env per request (a worker). Built once per
 * set of settings; until they're complete it answers 503 with what's missing (names only).
 */
export function relayFromEnv(extra: { fetch?: typeof fetch; log?: (m: string) => void } = {}): (req: Request, env: Env) => Promise<Response> {
  let built: { key: string; handler: RelayHandler } | null = null;
  return async (req, env) => {
    const key = RELAY_ENV.required.map((k) => env[k] ?? "").join("\u0000") + (env.DSA_RELAY_RUNNER_TOKEN ?? "");
    if (!built || built.key !== key) {
      const problems = relayEnvProblems(env);
      if (problems.length) return new Response(JSON.stringify({ error: "The relay isn't configured yet.", missing: problems }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      built = { key, handler: createRelay(relayOptionsFromEnv(env, extra)) };
    }
    return built.handler(req);
  };
}
