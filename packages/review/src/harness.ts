import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveTargets, type Config } from '@snds/dsa/engine';
import { packageEntry } from './apps.js';

/**
 * Drawing a proposal without its stories. The design system's component is mounted straight from its
 * source in a small page its own Vite serves, with what its Storybook adds around every story: the
 * preview file (`.storybook/preview.*`), which loads the system's CSS and holds its providers and
 * decorators. Stories aren't needed, so a component with none (or whose stories don't show these props)
 * is drawn all the same, with the proposal's props and the element's own words and icon.
 *
 * Parts that only live inside something closed (SelectItem, SidebarMenuButton) are mounted inside their
 * family, opened: the component's module exports the family (Select, Sidebar, SidebarMenu), and
 * SidebarProvider or SelectContent where they exist. A part that needs data gets empty lists to start;
 * what still doesn't draw says why in plain words.
 *
 * Needs Vite and React installed where the design system is; without them, proposals come from stories.
 */
export interface Harness { url: string; stop: () => Promise<void>; how: string }

/** Where the system's components live (the core target holding most of their files). */
function coreDir(root: string, config: Config, files: string[]): string | null {
  let cores: { dir: string }[] = [];
  try { cores = resolveTargets(root, config).filter(t => t.role === 'core'); } catch { /* no design system configured: the components' own folder */ }
  const score = (d: string) => files.filter(f => f.startsWith(d + path.sep)).length;
  return cores.sort((a, b) => score(b.dir) - score(a.dir))[0]?.dir ?? (files[0] ? path.dirname(files[0]) : null);
}

/** The Storybook preview file nearest the system: its CSS imports, providers and decorators. */
export function previewFile(from: string, root: string): string | null {
  for (let d = path.resolve(from); ; d = path.dirname(d)) {
    for (const n of ['preview.tsx', 'preview.ts', 'preview.jsx', 'preview.js']) {
      const f = path.join(d, '.storybook', n);
      if (fs.existsSync(f)) return f;
    }
    if (d === path.resolve(root) || path.dirname(d) === d) return null;
  }
}

const fsUrl = (f: string) => '/@fs' + path.resolve(f).split(path.sep).join('/');

/**
 * The page's own module: React, the preview, and `window.__dsaDraw`. Fixed text apart from the preview's
 * path; what it draws comes in as arguments.
 */
function harnessModule(preview: string | null) {
  return `import { createElement as h, Component } from 'react';
import { createRoot } from 'react-dom/client';
${preview ? `import * as preview from ${JSON.stringify(fsUrl(preview))};` : 'const preview = {};'}
class Guard extends Component {
  constructor(p) { super(p); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { window.__dsaErr = String((err && err.message) || err).slice(0, 200); }
  render() { return this.state.failed ? null : this.props.children; }
}
const decorators = [...((preview.default && preview.default.decorators) || []), ...(preview.decorators || [])];
const EMPTY = { data: [], rows: [], items: [], options: [], columns: [] };
let root = null;
const mount = async (tree) => {
  window.__dsaErr = null;
  if (root) root.unmount();
  const host = document.getElementById('root');
  host.replaceChildren();
  root = createRoot(host);
  let story = () => tree;
  for (const d of decorators) { const inner = story; story = () => d(inner, { args: {}, parameters: {}, globals: {}, viewMode: 'story', id: 'dsa--harness' }); }
  root.render(h(Guard, null, h(() => story())));
  await new Promise((r) => setTimeout(r, 350));
  return window.__dsaErr;
};
window.__dsaDraw = async ({ file, name, props, text, icon, slot, empty }) => {
  let mod;
  try { mod = await import(/* @vite-ignore */ file); } catch (e) { return { ok: false, why: 'its file did not load: ' + String((e && e.message) || e).slice(0, 160) }; }
  const C = mod[name];
  if (!C) return { ok: false, why: name + " isn't exported from its file" };
  let child = text || null;
  if (icon) {
    try { const m = await import(/* @vite-ignore */ icon.file); const I = icon.name.split('.').reduce((o, k) => o && o[k], m) || m.default; if (I) child = text ? [h(I, { key: 'i' }), text] : h(I); } catch (e) { /* drawn without it */ }
  }
  const el = (data) => h(C, { ...(data ? EMPTY : {}), ...props }, child);
  // Its family, opened: every exported name it starts with (Sidebar, SidebarMenu), the provider, the content.
  const fam = Object.keys(mod).filter((k) => k !== name && name.startsWith(k) && /^[A-Z]/.test(k) && typeof mod[k] !== 'string').sort((a, b) => a.length - b.length);
  const wrap = (inner) => {
    if (!fam.length) return inner;
    const base = fam[0];
    const content = [base + 'Content', base + 'Popup'].find((n) => mod[n] && n !== name && !name.startsWith(n));
    let t = content ? h(mod[content], { forceMount: true }, inner) : inner;
    for (const f of [...fam].reverse()) t = h(mod[f], { open: true, defaultOpen: true }, t);
    if (mod[base + 'Provider']) t = h(mod[base + 'Provider'], { open: true, defaultOpen: true }, t);
    return t;
  };
  const tries = [fam.length ? wrap(el(false)) : null, el(false), empty ? (fam.length ? wrap(el(true)) : el(true)) : null].filter(Boolean);
  let why = null;
  for (const t of tries) {
    why = await mount(t);
    if (!why && document.querySelector('[data-slot="' + slot + '"]')) return { ok: true };
  }
  return { ok: false, why: why ? 'it failed to draw: ' + why : 'it drew, but nothing showed with its data-slot' };
};
window.__dsaReady = true;
`;
}

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>dsa harness</title></head><body style="margin:0;padding:24px;background:#fff"><div id="root"></div><script type="module" src="/@dsa/harness"></script></body></html>';

/** Start the harness, or say why it can't (null, with the reason logged). */
export async function startHarness(root: string, config: Config, sigFiles: string[], log: (m: string) => void): Promise<Harness | null> {
  if (config.rendered?.harness === false) return null;
  const dir = coreDir(root, config, sigFiles);
  if (!dir) return null;
  const viteEntry = packageEntry(dir, 'vite');
  if (!viteEntry || !packageEntry(dir, 'react-dom', './client')) { log("Proposals: no Vite and React installed with the design system, so they're drawn from its stories only."); return null; }
  const preview = previewFile(dir, root);
  const vite = await import(pathToFileURL(viteEntry).href);
  const plugin = {
    name: 'dsa:harness',
    resolveId: (id: string) => (id === '/@dsa/harness' ? '\0dsa-harness.js' : null),
    load: (id: string) => (id === '\0dsa-harness.js' ? harnessModule(preview) : null),
    configureServer(server: any) {
      server.middlewares.use('/__dsa/harness', async (req: any, res: any) => { res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml(req.url ?? '/', PAGE)); });
    },
  };
  const own = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
  const server = await vite.createServer({
    root: dir, configFile: own ?? false, logLevel: 'silent', appType: 'custom', clearScreen: false,
    plugins: [plugin],
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, fs: { allow: [path.resolve(root)] } },
    optimizeDeps: { include: ['react', 'react-dom/client'] },
  });
  await server.listen();
  const base = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.config.server.port}/`;
  log(`Proposals: drawing from the system's own source with Vite${preview ? ` and ${path.relative(root, preview)}` : ' (no Storybook preview file found: no providers or global CSS from it)'}.`);
  return { url: new URL('__dsa/harness', base).toString(), stop: () => server.close(), how: preview ? 'source, with its Storybook preview' : 'source' };
}

/** Open the harness page and wait until it can draw (Vite may reload it once while it bundles React). */
export async function openHarness(page: any, h: Harness): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(h.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction('window.__dsaReady === true', null, { timeout: 30000 });
      await page.waitForTimeout(600);
      if (await page.evaluate('window.__dsaReady === true')) return true;
    } catch { /* reloaded while bundling: again */ }
  }
  return false;
}

/** The file an element's icon is imported from, resolved: a relative import from its file, or a package installed for it. */
export function iconFile(root: string, elementFile: string, name: string): string | null {
  const abs = path.resolve(root, elementFile);
  let src: string;
  try { src = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const base = name.split('.')[0]!;
  const m = [...src.matchAll(/import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g)].find(x => new RegExp(`(^|[{,\\s])${base}([,}\\s]|$)`).test(x[1]!));
  if (!m) return null;
  const spec = m[2]!;
  if (spec.startsWith('.')) {
    const stem = path.resolve(path.dirname(abs), spec);
    return [stem, ...['.tsx', '.ts', '.jsx', '.js'].map(e => stem + e), ...['index.tsx', 'index.ts', 'index.js'].map(i => path.join(stem, i))].find(f => fs.existsSync(f) && fs.statSync(f).isFile()) ?? null;
  }
  const parts = spec.split('/');
  const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  const sub = spec.length > pkg.length ? '.' + spec.slice(pkg.length) : '.';
  return packageEntry(path.dirname(abs), pkg, sub);
}

export const harnessUrlFor = fsUrl;
