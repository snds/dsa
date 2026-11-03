// Why proposals aren't "drawn exactly, with the element's own content" (trust check C4), counted by cause,
// from a published dashboard (its index.html). Read only.
//
//   node scripts/proposal-gaps.mjs <site>/index.html [--ids]
//
// Causes:
//   not drawn            no render at all, or the render says it couldn't draw it (check none)
//   own key missing      the element has its own content, but nothing was drawn under its own-content key,
//                        so the card falls back to the render with the story's sample
//   own not set          drawn under its own key, but putting its content in failed (the reason is printed)
//   no own content       nothing of its own to draw with (icon-only, no captured icon), so the sample shows
//   props unconfirmed    drawn, but its props weren't confirmed (unverified, closest)
import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/proposal-gaps.mjs <site>/index.html [--ids]'); process.exit(2); }
const html = fs.readFileSync(file, 'utf8');
const D = JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)[1]);
const E = D.elements;
const key = (use, props) => { const p = Object.entries(props ?? {}).filter(([k, v]) => k !== 'render' && k !== 'asChild' && v != null).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(';'); return p ? `${use}|${p}` : use; };
const proposes = new Map();
for (const q of E.questions ?? []) { for (const p of q.parts ?? []) for (const id of p.ids) proposes.set(id, p.auto); for (const id of q.ids) if (!proposes.has(id)) proposes.set(id, q.auto); }
const out = {}, why = {}, ids = {};
const add = (c, e, use) => { (out[c] ??= {}); out[c][use] = (out[c][use] ?? 0) + 1; (ids[c] ??= []).push(e.id); };
for (const e of (E.evals ?? []).filter(e => !e.exception && e.reach?.status !== 'unused' && e.verdict !== 'ignore')) {
  const r = proposes.get(e.id) ?? (e.decided ? e.decided.decision : e);
  if (r?.verdict !== 'replace' || !r.use) continue;
  const k = key(r.use, r.props);
  const mine = e.ownHash ? E.proposals?.[`${k}#${e.ownHash}`] : null;
  const p = mine || E.proposals?.[k] || null;
  const hasOwn = e.ownHash !== undefined ? Boolean(e.ownHash) : Boolean(e.label);
  const ok = p?.check === 'exact' && p.url && (hasOwn ? p.own : !p.content);
  if (ok) continue;
  if (!p || !p.url || p.check === 'none') add('not drawn', e, r.use);
  else if (p.check !== 'exact') add('props unconfirmed', e, r.use);
  else if (!hasOwn) add('no own content', e, r.use);
  else if (!mine) add('own key missing', e, r.use);
  else { add('own not set', e, r.use); why[mine.content ?? '?'] = (why[mine.content ?? '?'] ?? 0) + 1; }
}
const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u, n]) => `${u} ${n}`).join(', ');
for (const [c, m] of Object.entries(out)) console.log(`${c}: ${Object.values(m).reduce((a, b) => a + b, 0)} (${top(m)})`);
if (Object.keys(why).length) console.log(`own not set, why: ${top(why)}`);
if (process.argv.includes('--ids')) console.log(JSON.stringify(ids, null, 1));
