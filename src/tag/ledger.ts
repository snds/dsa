/**
 * The evidence ledger's runtime: a plain script run before the app's own, in any page the tagger serves
 * (and every page the crawler opens). It listens to React's commits through the DevTools hook (installing
 * a minimal one when DevTools isn't there; React Refresh and DevTools wrap it as usual) and, for each
 * element with a source tag it hasn't seen on this URL, records:
 *
 * - the tag ("file:line:col") and the URL;
 * - its size on the page;
 * - its owner component: the nearest component above it, by name, and that component's props;
 * - each component above it, outermost first, with the values of its state hooks, in React's order, each
 *   with its name when the tagger named it (`__dsaStateName`, below).
 *
 * Values are copied with limits: functions become {"__dsa":"fn"}, a Set or Map {"__dsa":"set"|"map"},
 * React elements and DOM nodes null; depth 4, five items per list, 30 keys per object, 200 characters
 * per string; dsa's own marks (data-dsa-*) left out; and a key that looks like a credential or personal detail (password, token, email, phone,
 * address…) is "[redacted]". A copy that hit a limit is marked `cut`, so nobody sets it back as if whole.
 *
 * Records go to the crawler through `window.__dsaLedgerPut` when it exposes one, else to the dev server
 * (`POST /@dsa/ledger`) when the tagger was started with DSA_LEDGER set, else they stay in
 * `window.__dsaLedger.all` for whoever reads them. Nothing leaves the machine.
 */
export const LEDGER_RUNTIME = `(() => {
  if (window.__dsaLedger) return;
  const L = (window.__dsaLedger = { all: [], seen: new Set() });
  // State hooks by their setter: the tagger names each (setOpen → "open") as the component runs.
  const names = (window.__dsaStateNames = new WeakMap());
  window.__dsaStateName = (set, name, src) => { try { if (typeof set === 'function' && !names.has(set)) names.set(set, { name, src }); } catch {} };
  const MAX = 4000;
  const SECRET = /pass(word|code)?|secret|token|auth|session|cookie|credential|api.?key|email|phone|ssn|card.?(no|num)|cvv|iban|address/i;
  const cut = { on: false };
  const copy = (v, d, seen) => {
    if (v === undefined || v === null) return null;
    const t = typeof v;
    if (t === 'string') { if (v.length > 200) cut.on = true; return v.slice(0, 200); }
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'function') return { __dsa: 'fn' };
    if (t !== 'object') return null;
    if (v.$$typeof) { cut.on = true; return null; }
    if (typeof Node !== 'undefined' && v instanceof Node) { cut.on = true; return null; }
    if (v instanceof Set) return { __dsa: 'set' };
    if (v instanceof Map) return { __dsa: 'map' };
    if (v instanceof Date) return v.toISOString();
    if (d >= 4 || seen.has(v)) { cut.on = true; return null; }
    seen.add(v);
    if (Array.isArray(v)) { if (v.length > 5) cut.on = true; return v.slice(0, 5).map((x) => copy(x, d + 1, seen)); }
    const o = {};
    const keys = Object.keys(v);
    if (keys.length > 30) cut.on = true;
    for (const k of keys.slice(0, 30)) { if (k.startsWith('data-dsa-')) continue; o[k] = SECRET.test(k) ? '[redacted]' : copy(v[k], d + 1, seen); }
    return o;
  };
  const take = (v) => { cut.on = false; const value = copy(v, 0, new WeakSet()); return { value, cut: cut.on }; };
  const nameOf = (t) => !t ? '' : typeof t === 'function' ? (t.displayName || t.name || '') : typeof t === 'object' ? (t.displayName || nameOf(t.render) || nameOf(t.type)) : '';
  const isComp = (f) => f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15;
  const hooksOf = (f) => { const out = []; for (let h = f.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) if (h.queue && typeof h.queue.dispatch === 'function') out.push(h); return out; };
  const out = [];
  const record = (f) => {
    const el = f.stateNode;
    const src = el && el.getAttribute && el.getAttribute('data-dsa-src');
    if (!src || el.closest('#dsa-mount, #dsa-markup')) return;
    const key = src + ' ' + location.href;
    if (L.seen.has(key) || L.seen.size >= MAX) return;
    L.seen.add(key);
    const chain = [];
    for (let a = f.return; a && chain.length < 12; a = a.return) if (isComp(a) && nameOf(a.type)) chain.push(a);
    const box = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const owner = chain[0];
    const props = owner ? take(owner.memoizedProps) : null;
    const rec = {
      src, url: location.href, at: Date.now(), w: Math.round(box.width), h: Math.round(box.height),
      owner: owner ? { name: nameOf(owner.type), props: props.value, cut: props.cut } : null,
      ancestors: chain.slice().reverse().map((a) => ({ name: nameOf(a.type), hooks: a.tag === 1 ? [] : hooksOf(a).map((h) => { const t = take(h.memoizedState); const nm = names.get(h.queue.dispatch); return nm ? { ...t, name: nm.name } : t; }) })),
    };
    if (JSON.stringify(rec).length > 24000) { rec.ancestors = rec.ancestors.map((a) => ({ name: a.name, hooks: [] })); if (rec.owner) { rec.owner.props = null; rec.owner.cut = true; } }
    out.push(rec);
    L.all.push(rec);
    if (L.all.length > MAX) L.all.shift();
  };
  const roots = new Set();
  let timer = 0;
  const walk = () => {
    timer = 0;
    for (const root of roots) {
      const stack = [root.current];
      let n = 0;
      while (stack.length && n++ < 40000) {
        const f = stack.pop();
        if (!f) continue;
        if (f.tag === 5) record(f);
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
    }
    roots.clear();
    flush();
  };
  const flush = () => {
    if (!out.length) return;
    const batch = out.splice(0);
    try {
      if (typeof window.__dsaLedgerPut === 'function') window.__dsaLedgerPut(batch);
      else if (window.__dsaLedgerPost) fetch('/@dsa/ledger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch), keepalive: true }).catch(() => {});
    } catch {}
  };
  let hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) {
    let id = 0;
    hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map(), supportsFiber: true, isDisabled: false, inject(r) { id++; this.renderers.set(id, r); return id; }, onCommitFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {} };
  }
  const prev = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (id, root) {
    try { roots.add(root); if (!timer) timer = setTimeout(walk, 200); } catch {}
    return prev ? prev.apply(this, arguments) : undefined;
  };
  addEventListener('pagehide', () => { try { if (timer) { clearTimeout(timer); walk(); } } catch {} });
})();`;
