/**
 * Scripted flows and the crawler's network guard.
 *
 * The explorer (shots.ts) never fills, submits, or uploads. Some elements only appear after a person
 * does exactly that: posts a comment and opens its edit box, ticks two quotes and compares them, types
 * a name that matches nothing. A flow is that sequence written down in the config
 * (apps["name"].flows), reviewed in the PR like any other change, and replayed step by step.
 *
 * Every crawl, flows or not, runs behind the network guard: only GET/HEAD requests, nothing under
 * /api/, and nothing to another host except images, fonts, stylesheets, and media. So a flow that
 * "sends" or "uploads" changes nothing outside the browser tab, and nothing reaches a server that could
 * act on it (the prototype's Guided Setup forwards /api/ calls to a paid AI provider).
 */

export type Step =
  | { click: string; nth?: number; within?: string }
  | { dblclick: string; nth?: number; within?: string }
  | { hover: string; nth?: number; within?: string }
  | { check: string; nth?: number; within?: string }
  | { fill: { label: string; text: string }; nth?: number; within?: string }
  | { press: string }
  | { upload: string; nth?: number; within?: string }
  | { wait: number };

export interface Flow {
  name: string;
  /** Route to load first, as in apps["name"].routes. */
  route: string;
  steps: Step[];
  /** Element ids the flow is written for; a flow runs only while one of them is still missing (empty: always). */
  reveals?: string[];
  notes?: string;
}

const KINDS = ['click', 'dblclick', 'hover', 'check', 'fill', 'press', 'upload', 'wait'] as const;
type Kind = typeof KINDS[number];
/** Never acted on, even in a flow someone wrote down. */
export const NEVER = /delete|remove|discard|archive|sign ?out|log ?out|reset|deactivate|purchase|pay\b|buy\b|checkout/i;
const KEYS = /^(Enter|Escape|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space|Backspace)$/;

export const kindOf = (s: Step): Kind => KINDS.find(k => k in s)!;

/** Problems with a flow as written (empty: runnable). */
export function flowProblems(f: any): string[] {
  const out: string[] = [];
  if (!f || typeof f !== 'object') return ['not an object'];
  if (!f.name || typeof f.name !== 'string') out.push('no name');
  if (!f.route || typeof f.route !== 'string') out.push('no route');
  if (!Array.isArray(f.steps) || !f.steps.length) out.push('no steps');
  for (const [i, s] of (Array.isArray(f.steps) ? f.steps : []).entries()) {
    const kinds = KINDS.filter(k => s && k in s);
    if (kinds.length !== 1) { out.push(`step ${i + 1}: needs exactly one of ${KINDS.join(', ')}`); continue; }
    const k = kinds[0], v = s[k];
    if (k === 'wait' && !(Number.isFinite(v) && v >= 0 && v <= 10_000)) out.push(`step ${i + 1}: wait is 0–10000 ms`);
    else if (k === 'press' && !KEYS.test(String(v))) out.push(`step ${i + 1}: press takes one of ${KEYS.source}`);
    else if (k === 'fill' && !(v && typeof v.label === 'string' && typeof v.text === 'string' && v.text.length <= 200)) out.push(`step ${i + 1}: fill needs a label and text (≤200 characters)`);
    else if (!['wait', 'press', 'fill'].includes(k) && (typeof v !== 'string' || !v.trim())) out.push(`step ${i + 1}: ${k} needs a label`);
    else if (k !== 'wait' && k !== 'press' && NEVER.test(k === 'fill' ? v.label : v)) out.push(`step ${i + 1}: "${k === 'fill' ? v.label : v}" is never acted on`);
  }
  return out;
}

export const describeStep = (s: Step): string => {
  const k = kindOf(s), v: any = (s as any)[k];
  if (k === 'fill') return `typing into “${v.label}”`;
  if (k === 'press') return `pressing ${v}`;
  if (k === 'wait') return `waiting ${v} ms`;
  if (k === 'upload') return `uploading a test image via “${v}”`;
  return `${k === 'dblclick' ? 'double-clicking' : k === 'hover' ? 'hovering' : k === 'check' ? 'ticking' : 'clicking'} “${v}”`;
};

/** A 1×1 PNG: the only file a flow ever uploads. */
export const TEST_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** Block everything that could change state off the page. Returns a counter of blocked requests. */
/**
 * A route under the app's URL. Routes come from the app's own source, so "/materials" is relative to
 * where the app is mounted: https://example.com/app/ + /materials → https://example.com/app/materials.
 */
export function routeUrl(route: string, base: URL): string {
  const mount = base.pathname.endsWith('/') ? base.pathname : base.pathname.replace(/[^/]*$/, '');
  if (route.startsWith('/') && mount !== '/' && !route.startsWith(mount)) return new URL(mount + route.slice(1), base).toString();
  return new URL(route, base).toString();
}

export interface GuardOptions {
  /** GET the app's own /api/ routes. */
  readApi?: boolean | undefined;
  /** Data paths to GET besides: globs on the app's origin ("/record-service/**") or full URLs for another host. */
  readPaths?: string[] | undefined;
  /** The identity provider's origin, when known. */
  idp?: string | undefined;
  /** True while the crawler is signing in: a page sent to another host then is the identity provider. */
  signingIn?: () => boolean;
}

export interface GuardStats {
  blocked: number;
  last: string[];
  /** Requests let through for sign-in and data reads ("GET https://id.example.com/realms/x/protocol/…"), by count. Paths only: no query strings, no bodies. */
  allowed: Record<string, number>;
  /** Requests stopped, by method and path, by count. */
  denied: Record<string, number>;
  /** Identity provider origins: given, or learned from the sign-in redirect. */
  idp: Set<string>;
}

/** "/record-service/**" → a RegExp over the origin and path. A glob without a host is on `origin`. */
export function globMatcher(globs: string[] | undefined, origin: string): (u: URL) => boolean {
  const res = (globs ?? []).map(g => {
    const full = /^https?:\/\//.test(g) ? g : origin + (g.startsWith('/') ? g : '/' + g);
    const src = full.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
    return new RegExp(`^${src}$`);
  });
  return (u: URL) => res.some(r => r.test(u.origin + u.pathname));
}

/** A token endpoint: where an OIDC or OAuth client trades its code for tokens. */
const TOKEN = /\/(protocol\/openid-connect\/token|oauth2?\/token|connect\/token|token)$/;

/**
 * Read-only browsing. Reads (GET, HEAD) of the app's own pages pass, and of its /api/ only with readApi
 * or a readPaths entry; another host's images, fonts, styles and media pass. To sign in, the identity
 * provider may be read, and posted to at its token endpoint only. Everything else is stopped: every
 * write to the app, every other host. What was let through for sign-in or data, and what was stopped,
 * is counted by method and path (never a query string or a body, so no token or code is ever kept).
 */
export async function guardNetwork(page: any, origin: string, opts: GuardOptions = {}): Promise<GuardStats> {
  const stats: GuardStats = { blocked: 0, last: [], allowed: {}, denied: {}, idp: new Set(opts.idp ? [new URL(opts.idp).origin] : []) };
  const reads = globMatcher(opts.readPaths, origin);
  const count = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  await page.route('**/*', (route: any) => {
    const r = route.request();
    let u: URL | null = null;
    try { u = new URL(r.url()); } catch { /* data:, blob: */ }
    const method = r.method();
    const read = method === 'GET' || method === 'HEAD';
    const local = !u || u.origin === origin || /^(data|blob):$/.test(u.protocol);
    const passive = ['image', 'font', 'stylesheet', 'media'].includes(r.resourceType());
    const key = `${method} ${u ? u.origin + u.pathname : r.url().slice(0, 40)}`;
    let ok = false, special = false;
    if (local) {
      // A live, signed-in site loads its data from its own API: reads may pass (readApi, readPaths), writes never do.
      ok = read && (opts.readApi || !(u && u.pathname.startsWith('/api/')) || (special = Boolean(u && reads(u))));
    } else if (u) {
      // A page sent to another host while signing in is the identity provider (learned from the redirect).
      if (!stats.idp.has(u.origin) && opts.signingIn?.() && r.isNavigationRequest() && r.frame() === page.mainFrame()) stats.idp.add(u.origin);
      if (stats.idp.has(u.origin)) { ok = read || ((method === 'POST' || method === 'OPTIONS') && TOKEN.test(u.pathname)); special = ok; }
      else if (read && reads(u)) { ok = true; special = true; }
      else ok = read && passive;
    }
    if (ok) { if (special) count(stats.allowed, key); return route.continue(); }
    stats.blocked++;
    count(stats.denied, key);
    stats.last = [...stats.last.slice(-4), key];
    return route.abort('blockedbyclient');
  });
  return stats;
}

/** "allowed GET https://id.example.com/auth (2), POST …/token (1) · blocked POST /record-service/save (3)": paths only. */
export function describeNetwork(n: GuardStats, origin: string): string {
  const list = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, c]) => `${k.replace(' ' + origin, ' ')}${c > 1 ? ` (${c})` : ''}`).join(', ');
  return [Object.keys(n.allowed).length ? `allowed ${list(n.allowed)}` : '', Object.keys(n.denied).length ? `blocked ${list(n.denied)}` : ''].filter(Boolean).join(' · ');
}

/**
 * Runs in the page: mark the control a step targets (data-dsa-flow), or report why not.
 * Names: aria-label, title, visible text without icon glyphs, placeholder, <label>, aria-labelledby.
 */
export const FIND_TARGET = `(o) => {
  document.querySelectorAll('[data-dsa-flow]').forEach(e => e.removeAttribute('data-dsa-flow'));
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const words = (el) => { const c = el.cloneNode(true); c.querySelectorAll('[data-slot=icon], .material-symbols-outlined, .material-symbols-rounded, .material-icons, svg, [aria-hidden=true]').forEach(x => x.remove()); return c.textContent || ''; };
  const byId = (ids) => (ids || '').split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(e => e.textContent).join(' ');
  const labelFor = (el) => { const l = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); return (l && l.textContent) || (el.closest('label') && el.closest('label').textContent) || ''; };
  const names = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), byId(el.getAttribute('aria-labelledby')), words(el), el.textContent, el.getAttribute('placeholder'), labelFor(el), el.getAttribute('name')].map(norm).filter(Boolean);
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const sel = {
    click: 'button, a, [role=button], [role=menuitem], [role=menuitemradio], [role=tab], [role=option], [role=row], [role=gridcell], [role=link], [role=switch], [role=checkbox], summary, [tabindex]',
    check: 'input[type=checkbox], [role=checkbox]',
    fill: 'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), textarea, [contenteditable=""], [contenteditable=true], [role=combobox], [role=searchbox], [role=textbox]',
    upload: 'input[type=file], button, [role=button], label',
  }[o.kind === 'dblclick' || o.kind === 'hover' ? 'click' : o.kind];
  let scope = document;
  if (o.within) {
    const want = norm(o.within);
    const regions = Array.from(document.querySelectorAll('[role=dialog], [role=alertdialog], dialog, [data-slot$="-content"], aside, section, [role=region], [role=complementary]')).filter(vis);
    scope = regions.find(r => names(r).some(n => n === want || n.startsWith(want))) || null;
    if (!scope) return { ok: false, why: 'no visible region named “' + o.within + '”' };
  }
  const want = norm(o.label);
  const hits = Array.from(scope.querySelectorAll(sel)).filter(el => (vis(el) || (o.kind === 'upload' && el.matches('input[type=file]'))) && !el.closest(':disabled,[aria-disabled="true"]'))
    .filter(el => names(el).some(n => n === want)).filter((el, i, a) => !a.some(p => p !== el && p.contains(el) && o.kind !== 'fill'));
  if (!hits.length) {
    // A looser match: the name starts with the label ("Comments (3)").
    const loose = Array.from(scope.querySelectorAll(sel)).filter(vis).filter(el => names(el).some(n => n.startsWith(want)));
    // Clickable rows without a role (a <div onClick> feed item): the smallest visible element whose own text is the label.
    const plain = loose.length || !['click', 'dblclick', 'hover'].includes(o.kind) ? [] : Array.from(scope.querySelectorAll('div, p, span, li, td, h3, h4, strong')).filter(vis)
      .filter(el => norm(el.textContent) === want).filter((el, i, a) => !a.some(c => c !== el && el.contains(c)));
    if (!loose.length && !plain.length) return { ok: false, why: 'nothing named “' + o.label + '”' };
    hits.push(...loose, ...plain);
  }
  const el = hits[Math.min(o.nth || 0, hits.length - 1)];
  el.setAttribute('data-dsa-flow', '1');
  return { ok: true, n: hits.length, file: el.matches('input[type=file]') };
}`;

/**
 * Run one flow from its route: perform each step, look for missing elements after each one.
 * Returns the step it stopped at (and why), or done.
 */
export async function runFlow(page: any, f: Flow, opts: { base: URL; waitMs: number; inPage: (src: string, arg: unknown) => Promise<any>; sweep: (by: string) => Promise<void>; log: (m: string) => void }): Promise<{ done: boolean; at?: number; why?: string }> {
  // A fresh document every time: going #/a → #/b only changes the hash, so an app keeps whatever the last
  // flow left open (a modal's overlay then swallows every click).
  await page.goto('about:blank').catch(() => {});
  await page.goto(routeUrl(f.route, opts.base), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(opts.waitMs);
  const path: string[] = [];
  for (const [i, s] of f.steps.entries()) {
    const k = kindOf(s), v: any = (s as any)[k];
    try {
      if (k === 'wait') await page.waitForTimeout(v);
      else if (k === 'press') await page.keyboard.press(v === 'Space' ? ' ' : v);
      else {
        const label = k === 'fill' ? v.label : v;
        if (NEVER.test(label)) return { done: false, at: i, why: `“${label}” is never acted on` };
        const hit = await opts.inPage(FIND_TARGET, { kind: k, label, nth: (s as any).nth ?? 0, within: (s as any).within });
        if (!hit?.ok) return { done: false, at: i, why: hit?.why ?? 'target not found' };
        const loc = page.locator('[data-dsa-flow]').first();
        // An explicit step: if something sits over the target (a sticky header, a tooltip), click through it once.
        const force = <T>(fn: (o: any) => Promise<T>) => fn({ timeout: 3000 }).catch(() => fn({ timeout: 3000, force: true }));
        if (k === 'click') await force(o => loc.click(o));
        else if (k === 'dblclick') await force(o => loc.dblclick(o));
        else if (k === 'hover') await loc.hover({ timeout: 3000, force: true });
        else if (k === 'check') await loc.check({ timeout: 3000 }).catch(() => force(o => loc.click(o)));
        else if (k === 'fill') { await loc.click({ timeout: 3000 }).catch(() => {}); await loc.fill(v.text, { timeout: 3000 }).catch(() => page.keyboard.type(v.text)); }
        else if (k === 'upload') {
          const file = { name: 'dsa-test.png', mimeType: 'image/png', buffer: TEST_PNG };
          if (hit.file) await loc.setInputFiles(file);
          else { const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 4000 }), loc.click({ timeout: 3000 })]); await fc.setFiles(file); }
        }
      }
    } catch (e: any) {
      return { done: false, at: i, why: String(e?.message ?? e).split('\n')[0].slice(0, 120) };
    }
    path.push(describeStep(s));
    await page.waitForTimeout(k === 'wait' ? 0 : 400);
    await opts.sweep(`flow “${f.name}”: ${path.join(' › ')}`);
  }
  return { done: true };
}
