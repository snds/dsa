import http from 'node:http';
import net from 'node:net';
import { freePort } from './apps.js';

/**
 * The component picker's live preview goes through this proxy instead of straight to Storybook.
 * It passes everything through (HMR websocket included) and adds one small script to iframe.html,
 * so the report can ask the preview for a story's argTypes and render content Storybook's URL and
 * postMessage args can't carry: an Icon element next to the label, the way each instance will look.
 * Works against the dev server and a static build (the Icon comes from its story file, elements are
 * built with the symbol of one React already rendered).
 */

const HELPER = String.raw`(() => {
  const post = (m) => parent.postMessage(Object.assign({ dsa: 1, from: 'preview' }, m), '*');
  const resources = () => performance.getEntriesByType('resource').map((e) => e.name);
  let IconC = null, sym = null, sent = [];
  // Elements are built by hand, so this works in the dev server and in a static build alike: the
  // element type symbol comes from an element React already rendered on the page.
  async function elementSymbol() {
    if (sym) return sym;
    // Wait for the story's first render: the symbol is read off an element React rendered.
    let node = null;
    for (let i = 0; i < 60 && !node; i++) {
      const root = document.getElementById('storybook-root') || document.getElementById('root');
      node = root && root.firstElementChild;
      if (!node) await new Promise((r) => setTimeout(r, 100));
    }
    let f = null;
    if (node) for (const k in node) if (k.indexOf('__reactFiber$') === 0) { f = node[k]; break; }
    for (let i = 0; f && i < 80; i++, f = f.return) {
      const c = f.memoizedProps && f.memoizedProps.children;
      const cand = Array.isArray(c) ? c.find((x) => x && x.$$typeof) : c;
      if (cand && typeof cand === 'object' && cand.$$typeof) { sym = cand.$$typeof; return sym; }
      const root = f.memoizedState && f.memoizedState.element;
      if (root && root.$$typeof) { sym = root.$$typeof; return sym; }
    }
    return null;
  }
  const el = (type, props, key) => ({ $$typeof: sym, type: type, key: key == null ? null : String(key), ref: null, props: props || {}, _owner: null, _store: {} });
  // The Icon component, from a story file whose meta names it; if no story does, a stand-in glyph
  // with the markup a typical system Icon renders for an icon font (data-slot="icon", the icon font).
  async function icon(p, iconModule) {
    if (IconC) return IconC;
    // The design system's own Icon, straight from its module (Vite dev server): the real glyphs.
    if (iconModule) {
      try { const m = await import(/* @vite-ignore */ iconModule); if (m && typeof m.Icon === 'function') { IconC = m.Icon; return IconC; } } catch (err) { /* static build or blocked: next */ }
    }
    const store = p.storyStoreValue;
    const entries = Object.values((store.storyIndex && store.storyIndex.entries) || {}).filter((x) => x.type === 'story' && /icon/i.test((x.importPath || '') + ' ' + (x.title || '')));
    const seen = {};
    for (const e of entries) {
      if (seen[e.importPath]) continue;
      seen[e.importPath] = 1;
      try {
        const csf = await store.loadCSFFileByStoryId(e.id);
        const c = csf && csf.meta && csf.meta.component;
        if (c && /(^|\/)icon(\.stories)?\.[jt]sx?$/i.test(e.importPath || '') || (c && (c.displayName === 'Icon' || c.name === 'Icon'))) { IconC = c; return IconC; }
      } catch (err) { /* next */ }
    }
    // An older build may not load the icon font; borrow it so the glyph isn't raw text.
    const hasFont = [...document.fonts].some((f) => /Material Symbols/i.test(f.family));
    if (!hasFont && !document.getElementById('dsa-icon-font')) {
      const l = document.createElement('link');
      l.id = 'dsa-icon-font'; l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200';
      document.head.appendChild(l);
    }
    IconC = function Glyph(props) {
      return el('span', {
        'data-slot': 'icon', 'data-icon-set': 'material', 'aria-hidden': true,
        className: 'inline-block shrink-0 overflow-hidden align-middle select-none',
        style: { fontFamily: 'var(--font-icon, "Material Symbols Outlined Variable"), "Material Symbols Outlined"', fontSize: 16, fontStyle: 'normal', fontWeight: 400, width: '1em', height: '1em', lineHeight: 1, letterSpacing: 'normal', textTransform: 'none', whiteSpace: 'nowrap', direction: 'ltr', fontFeatureSettings: '"liga"', WebkitFontSmoothing: 'antialiased' },
        children: props.name,
      });
    };
    IconC.stand = true;
    return IconC;
  }
  async function ready() {
    for (let i = 0; i < 150; i++) {
      const p = window.__STORYBOOK_PREVIEW__;
      if (p && p.storyStoreValue) return p;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('The Storybook preview did not start.');
  }
  const clean = (v, d) => {
    d = d || 0;
    if (d > 5 || typeof v === 'function') return undefined;
    if (Array.isArray(v)) return v.map((x) => clean(x, d + 1));
    if (v && typeof v === 'object') {
      if (v.$$typeof) return undefined;
      const o = {};
      for (const k in v) { const c = clean(v[k], d + 1); if (c !== undefined) o[k] = c; }
      return o;
    }
    return v;
  };
  addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d.dsa !== 1 || d.from !== 'report') return;
    try {
      const p = await ready();
      if (d.type === 'describe') {
        const story = await p.storyStoreValue.loadStory({ storyId: d.storyId });
        post({ type: 'described', storyId: d.storyId, argTypes: clean(story.argTypes), initialArgs: clean(story.initialArgs), jsx: !!(await elementSymbol()) });
      }
      // A component with no story: render it directly from its module, through a small harness
      // module on the dev server (its own React root, over the host story).
      if (d.type === 'mount') {
        const h = await import(/* @vite-ignore */ d.harness);
        await h.mount(d.module, d.exportName, d.args || {}, d.content || null, d.iconModule || null);
        post({ type: 'mounted', exportName: d.exportName });
        return;
      }
      if (d.type === 'args') {
        const args = Object.assign({}, d.args);
        let jsx = false;
        if (d.content) {
          const S = await elementSymbol();
          const I = await icon(p, d.iconModule);
          if (S) {
            const kids = [];
            if (d.content.leading && I) kids.push(el(I, { name: d.content.leading }, 'l'));
            if (d.content.label) kids.push(d.content.label);
            if (d.content.trailing && I) kids.push(el(I, { name: d.content.trailing }, 't'));
            if (kids.length) args.children = kids.length === 1 ? kids[0] : kids;
            jsx = !!I || !(d.content.leading || d.content.trailing);
          } else if (d.content.label) args.children = d.content.label;
        }
        const gone = sent.filter((k) => !(k in args));
        if (gone.length) await p.onResetArgs({ storyId: d.storyId, argNames: gone });
        await p.onUpdateArgs({ storyId: d.storyId, updatedArgs: args });
        sent = Object.keys(args);
        post({ type: 'applied', storyId: d.storyId, jsx: jsx, icons: IconC ? (IconC.stand ? 'glyph' : 'component') : false });
      }
    } catch (e) { post({ type: 'error', message: String((e && e.message) || e) }); }
  });
  post({ type: 'hello' });
})();`;

/**
 * Written next to the Storybook app (inside its node_modules cache, so 'react' resolves to the same
 * copy its stories use) and imported by the helper. Plain JS, no JSX, so Vite only rewrites imports.
 */
export const HARNESS = String.raw`import * as React from 'react';
import { createRoot } from 'react-dom/client';

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidUpdate(prev) { if (prev.k !== this.props.k && this.state.err) this.setState({ err: null }); }
  render() {
    if (!this.state.err) return this.props.children;
    return React.createElement('pre', { style: { color: '#b42318', font: '12px/1.5 ui-monospace, monospace', whiteSpace: 'pre-wrap', margin: 0 } },
      'It rendered, then threw: ' + String((this.state.err && this.state.err.message) || this.state.err) + '\n\nIt may need a provider or required props its stories would supply.');
  }
}

let root = null, n = 0;
export async function mount(moduleUrl, name, props, content, iconUrl) {
  const mod = await import(/* @vite-ignore */ moduleUrl);
  const C = mod[name] || (mod.default && (mod.default.displayName === name || mod.default.name === name) ? mod.default : null);
  if (!C) throw new Error(name + ' is not exported from ' + moduleUrl.split('/').pop() + '.');
  let Icon = null;
  if (iconUrl && content && (content.leading || content.trailing)) { try { Icon = (await import(/* @vite-ignore */ iconUrl)).Icon || null; } catch (e) { Icon = null; } }
  const kids = [];
  if (content && content.leading && Icon) kids.push(React.createElement(Icon, { key: 'l', name: content.leading }));
  if (content && content.label) kids.push(content.label);
  if (content && content.trailing && Icon) kids.push(React.createElement(Icon, { key: 't', name: content.trailing }));
  if (!root) {
    const host = document.getElementById('storybook-root') || document.getElementById('root');
    if (host) host.style.display = 'none';
    const el = document.createElement('div');
    el.id = 'dsa-mount';
    el.style.cssText = 'padding:16px;display:flex;align-items:flex-start;gap:8px;';
    document.body.appendChild(el);
    root = createRoot(el);
  }
  n++;
  const p = Object.assign({}, props);
  root.render(React.createElement(Boundary, { k: n }, kids.length ? React.createElement(C, p, ...kids) : React.createElement(C, p)));
}
`;

export async function startProxy(upstream: string): Promise<{ url: string; stop: () => void }> {
  const up = new URL(upstream);
  const server = http.createServer((req, res) => {
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: up.host };
    delete headers['accept-encoding'];
    const isIframe = (req.url ?? '').split('?')[0].endsWith('/iframe.html');
    const pr = http.request({ host: up.hostname, port: up.port, method: req.method, path: req.url, headers }, r => {
      if (isIframe && /html/.test(String(r.headers['content-type'] ?? ''))) {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', c => { body += c; });
        r.on('end', () => {
          // Spliced, not String.replace: the helper contains "$'", which replace() would expand.
          const at = body.lastIndexOf('</body>');
          const html = at >= 0 ? body.slice(0, at) + `<script>${HELPER}</script>` + body.slice(at) : body + `<script>${HELPER}</script>`;
          const h = { ...r.headers };
          delete h['content-length'];
          res.writeHead(r.statusCode ?? 200, h);
          res.end(html);
        });
      } else {
        res.writeHead(r.statusCode ?? 200, r.headers);
        r.pipe(res);
      }
    });
    pr.on('error', e => { if (!res.headersSent) res.writeHead(502); res.end(String(e)); });
    req.pipe(pr);
  });
  // Vite's HMR websocket: pass the upgrade straight through.
  server.on('upgrade', (req, sock, head) => {
    const conn = net.connect(Number(up.port), up.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${/^host$/i.test(req.rawHeaders[i]) ? up.host : req.rawHeaders[i + 1]}`);
      conn.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) conn.write(head);
      sock.pipe(conn).pipe(sock);
    });
    conn.on('error', () => sock.destroy());
    sock.on('error', () => conn.destroy());
  });
  const port = await freePort();
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => ok()); });
  return { url: `http://127.0.0.1:${port}/`, stop: () => server.close() };
}
