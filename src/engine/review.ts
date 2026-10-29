import crypto from 'node:crypto';
import { system } from './system.js';
import fs from 'node:fs';
import path from 'node:path';
import { describe, type Recommendation } from './classify.js';
import type { Config } from './config.js';
import { readDecisions, recordDecision, writeDecisions, DEFAULT_THRESHOLD, type ElementEval, type Policy } from './elements.js';
import { questions } from './questions.js';
import { openStore } from './store.js';
import { resolveTargets } from './workspaces.js';

/** Element review from the latest run: list, group, decide, and write a migration plan. */

export async function latestEvals(dataDir: string, target?: string): Promise<{ runId: string | null; evals: ElementEval[] }> {
  const store = await openStore(dataDir, 'review');
  try {
    const run = (await store.all<any>('select run_id from runs order by taken_at desc limit 1'))[0]?.run_id ?? null;
    if (!run) return { runId: null, evals: [] };
    const rows = await store.all<any>(`select data from element_evals where run_id=$1 ${target ? 'and target=$2' : ''} order by target, file, line`, target ? [run, target] : [run]);
    return { runId: run, evals: rows.map(r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data)) };
  } finally { store.close(); }
}

export const effective = (e: ElementEval): Recommendation => e.decided?.decision ?? e;
export const groupKey = (e: ElementEval) => `${e.element} → ${describe(effective(e))}`;

export interface Group { key: string; element: string; rec: Recommendation; items: ElementEval[]; min: number; max: number; needsHuman: number; decided: number; ruleIds: string[] }

export function groupEvals(evals: ElementEval[]): Group[] {
  const m = new Map<string, Group>();
  for (const e of evals) {
    const k = groupKey(e);
    const g = m.get(k) ?? { key: k, element: e.element, rec: effective(e), items: [], min: 1, max: 0, needsHuman: 0, decided: 0, ruleIds: [] };
    g.items.push(e);
    g.min = Math.min(g.min, e.confidence); g.max = Math.max(g.max, e.confidence);
    if (e.needsHuman) g.needsHuman++;
    if (e.decided) g.decided++;
    if (!g.ruleIds.includes(e.ruleId)) g.ruleIds.push(e.ruleId);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.items.length - a.items.length);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function printElements(evals: ElementEval[], opts: { list?: boolean | undefined; needsHuman?: boolean | undefined; json?: boolean | undefined; patterns?: boolean | undefined }) {
  if (opts.patterns) {
    console.log('Shared styles (decide once with: dsa decide --pattern <name> …)\n');
    for (const p of patterns(evals)) console.log(`${String(p.items.length).padStart(4)}  ${(p.named ? p.key : `identical classes ${p.key}`).padEnd(40)} ${p.files} file(s)  ${pct(p.min)}–${pct(p.max)}  → ${p.recs.map(r => `${r.rec} ×${r.n}`).join(', ')}${p.decided ? `  (${p.decided} decided)` : ''}`);
    return;
  }
  let rows = evals;
  if (opts.needsHuman) rows = rows.filter(e => e.needsHuman);
  if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  const active = rows.filter(e => !e.exception);
  const counts = {
    total: active.length,
    sure: active.filter(e => !e.needsHuman && !e.decided && e.verdict === 'replace').length,
    human: active.filter(e => e.needsHuman).length,
    gaps: active.filter(e => effective(e).verdict === 'gap').length,
    decided: active.filter(e => e.decided).length,
    lab: rows.filter(e => e.exception === 'lab').length,
    deferred: rows.length - active.length - rows.filter(e => e.exception === 'lab').length,
  };
  const q = questions(active);
  console.log(`${counts.total} elements · ${counts.sure} ready to migrate (≥ threshold) · ${counts.human} need a human, as ${q.length} questions · ${counts.gaps} system gaps · ${counts.decided} decided · ${counts.deferred} in temporary/allowed exceptions${counts.lab ? ` · ${counts.lab} on lab pages (not product UI)` : ''}\n`);
  for (const g of groupEvals(active)) {
    console.log(`${String(g.items.length).padStart(4)}  ${g.key.padEnd(58)} ${pct(g.min)}–${pct(g.max)}${g.needsHuman ? `  (${g.needsHuman} need a human)` : ''}`);
    if (opts.list) for (const e of g.items) console.log(`        ${e.id}  ${e.file}:${e.line}  ${pct(e.confidence)}${e.decided ? `  decided by ${e.decided.by}` : ''}`);
  }
}

export function explain(e: ElementEval): string {
  const lines = [
    `${e.id}  ${e.target}  ${e.file}:${e.line}:${e.col}`,
    `  ${e.snippet}`,
    `  Recommendation: ${describe(e)}${e.from ? ` (from ${e.from})` : ''}${e.gap ? ` — ${e.gap}` : ''}`,
    `  Confidence: ${pct(e.confidence)} [rule ${e.ruleId}]${e.calibrated ? ` calibrated on ${e.calibrated.n} decisions` : ' (rule score, not yet calibrated)'}${e.needsHuman ? '  → needs a human decision' : ''}`,
    ...e.reasons.map(r => `    ${r.delta > 0 ? '+' : r.delta < 0 ? '−' : '•'}${r.delta ? Math.abs(Math.round(r.delta * 100)) + '%' : ''} ${r.text}`),
  ];
  if (e.alternatives.length) lines.push(`  Alternatives: ${e.alternatives.map(a => `${describe(a)} (${pct(a.confidence)})`).join('; ')}`);
  if (e.signature) {
    lines.push(`  Signature: ${e.signature.component} ${e.signature.variant}/${e.signature.size} — ${Math.round(e.signature.score * 100)}% fit${e.signature.runnerUp ? ` (next: ${e.signature.runnerUp.variant}/${e.signature.runnerUp.size} ${Math.round(e.signature.runnerUp.score * 100)}%)` : ''}`);
    if (e.signature.matched.length) lines.push(`    matches: ${e.signature.matched.join(' · ')}`);
    if (e.signature.mismatched.length) lines.push(`    differs: ${e.signature.mismatched.join(' · ')}`);
    if (e.signature.structure.length) lines.push(`    structure: ${e.signature.structure.join('; ')}`);
  } else if (e.visualDiffs.length) lines.push(`  Visual differences: ${e.visualDiffs.join(' ')}`);
  if (e.a11y.length) lines.push(`  Accessibility: ${e.a11y.join(' ')}`);
  if (e.exception) lines.push(`  Exception: ${e.exception}`);
  if (e.decided) lines.push(`  Decided by ${e.decided.by}${e.decided.who ? ` (${e.decided.who})` : ''}: ${describe(e.decided.decision)}${e.decided.note ? ` — ${e.decided.note}` : ''}`);
  return lines.join('\n');
}

/** Record a decision. Agents may only decide at or above the threshold; below it, a human must. */
export async function decide(root: string, config: Config, dataDir: string, id: string, opt: Record<string, any>) {
  const { evals } = await latestEvals(dataDir);
  // --pattern decides every element styled by one shared constant (or identical classes) at once.
  if (typeof opt.pattern === 'string') return decidePattern(root, config, evals, opt.pattern, opt);
  const e = evals.find(x => x.id === id || x.fingerprint === id || x.id === `E-${id}`);
  if (!e) throw new Error(`No evaluation ${id} in the latest run. Run "dsa elements --list" to see ids.`);
  const by = opt.by === 'agent' ? 'agent' : 'human';
  const threshold = config.review?.threshold ?? DEFAULT_THRESHOLD;
  if (by === 'agent' && e.confidence < threshold) {
    throw new Error(`${e.id} is at ${pct(e.confidence)}, below the ${pct(threshold)} review threshold. An agent can't decide it; ask a human:\n\n${explain(e)}`);
  }
  const decision = decisionFrom(e, opt);
  const target = resolveTargets(root, config).find(t => t.name === e.target);
  if (!target) throw new Error(`Target ${e.target} not found.`);
  const df = readDecisions(target.dir, config.rawElementDecisions);
  const entry = recordDecision(df, e, decision, by, typeof opt.who === 'string' ? opt.who : undefined, typeof opt.note === 'string' ? opt.note : undefined, new Date(), typeof opt.judgment === 'string' ? opt.judgment : undefined);
  return { entry, file: df.file, e, count: 1 };
}

function decisionFrom(e: ElementEval, opt: Record<string, any>): Recommendation {
  // From the review UI: the whole decision, content spec included.
  if (opt.decision && typeof opt.decision === 'object') return opt.decision as Recommendation;
  let decision: Recommendation;
  if (opt.accept) decision = { verdict: e.verdict, role: e.role, use: e.use, from: e.from, props: e.props, gap: e.gap };
  else if (opt.keep) decision = { verdict: 'keep', role: e.role };
  else if (opt.gap) decision = { verdict: 'gap', role: e.role, gap: typeof opt.gap === 'string' ? opt.gap : e.gap };
  else if (typeof opt.use === 'string') {
    const props = typeof opt.props === 'string' ? Object.fromEntries(opt.props.split(',').map(p => p.split('=').map(s => s.trim())).filter(p => p[0])) : {};
    decision = { verdict: 'replace', role: e.role, use: opt.use, from: typeof opt.from === 'string' && opt.from ? opt.from : e.use === opt.use ? e.from : undefined, props };
  } else throw new Error('Say what was decided: --accept, --keep, --gap ["what is missing"], or --use <Component> [--props k=v,k=v].');
  return decision;
}

async function decidePattern(root: string, config: Config, evals: ElementEval[], pattern: string, opt: Record<string, any>) {
  const members = evals.filter(e => e.styleKey === pattern || e.styleSig === pattern);
  if (!members.length) throw new Error(`No elements styled by "${pattern}" in the latest run. Run "dsa elements --patterns".`);
  const by = opt.by === 'agent' ? 'agent' : 'human';
  const threshold = config.review?.threshold ?? DEFAULT_THRESHOLD;
  const low = members.filter(m => m.confidence < threshold);
  if (by === 'agent' && low.length) throw new Error(`${low.length} of ${members.length} elements in "${pattern}" are below ${pct(threshold)}. An agent can't decide this pattern; ask a human.`);
  const decision = decisionFrom(members[0]!, opt);
  const isKey = members.some(m => m.styleKey === pattern);
  const policy: Policy = { match: isKey ? { styleKey: pattern } : { styleSig: pattern }, decision, why: typeof opt.note === 'string' ? opt.note : `Pattern decision for ${pattern}`, by, who: typeof opt.who === 'string' ? opt.who : undefined, date: new Date().toISOString().slice(0, 10) };
  const files: string[] = [];
  for (const tname of new Set(members.map(m => m.target))) {
    const target = resolveTargets(root, config).find(t => t.name === tname);
    if (!target) continue;
    const df = readDecisions(target.dir, config.rawElementDecisions);
    df.policies = [...df.policies.filter(p => JSON.stringify(p.match) !== JSON.stringify(policy.match)), policy];
    // A decision per member (so each element shows it), sharing one judgment: calibration counts the answer once.
    for (const m of members.filter(x => x.target === tname)) recordDecision(df, m, decision, by, policy.who, `pattern ${pattern}`, new Date(), `pattern:${pattern}`);
    writeDecisions(df);
    files.push(df.file);
  }
  return { entry: { by, agreed: members.every(m => JSON.stringify(m.use) === JSON.stringify(decision.use)) } as any, file: files.join(', '), e: members[0], count: members.length };
}

/** Shared styles: one class constant (or identical classes) on several native elements. One decision covers them all. */
export function patterns(evals: ElementEval[], min = 3) {
  const m = new Map<string, ElementEval[]>();
  for (const e of evals.filter(x => !x.exception)) {
    const k = e.styleKey ?? (e.styleSig ? `#${e.styleSig}` : null);
    if (k) m.set(k, [...(m.get(k) ?? []), e]);
  }
  return [...m.entries()].filter(([, v]) => v.length >= min).map(([k, items]) => ({
    key: k.startsWith('#') ? k.slice(1) : k, named: !k.startsWith('#'), items,
    files: new Set(items.map(i => i.file)).size,
    recs: groupEvals(items).map(g => ({ rec: describe(g.rec), n: g.items.length })),
    min: Math.min(...items.map(i => i.confidence)), max: Math.max(...items.map(i => i.confidence)),
    decided: items.filter(i => i.decided).length,
  })).sort((a, b) => b.items.length - a.items.length);
}

/**
 * The migration plan an agent works from. Grouped by recommendation, ready items first, with the
 * exact component/props, the evidence, and for low-confidence items the question to put to a human.
 */
/** A markdown table cell: backslashes first, then pipes, so neither breaks the row. */
const cell = (t: string) => t.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

export function planMarkdown(evals: ElementEval[], opts: { target?: string | undefined; threshold: number; shots?: Map<string, string>; mapper?: (e: ElementEval) => import('./mapping.js').Mapping | null }): string {
  const active = evals.filter(e => !e.exception && !['keep', 'ignore'].includes(effective(e).verdict));
  const ready = active.filter(e => !e.needsHuman && effective(e).verdict === 'replace');
  const qs = questions(evals);
  const gaps = active.filter(e => !e.needsHuman && effective(e).verdict === 'gap');
  const out: string[] = [];
  out.push(`# Element migration plan${opts.target ? ` — ${opts.target}` : ''}`, '');
  out.push(`Generated by dsa. Each element was read mechanically (classes, children, context) and matched against ${system().label} component signatures (structure, props, tokens). Confidence is a rule score, calibrated against human decisions once a rule has five or more. **At or above ${pct(opts.threshold)}: apply. Below: ask a human, then record the answer with \`dsa decide\`.**`, '');
  out.push(`| | Count |`, `| --- | --- |`, `| Ready (≥ ${pct(opts.threshold)} or decided) | ${ready.length} |`, `| Questions for a human | ${qs.length} (covering ${qs.reduce((a, q) => a + q.items.length, 0)} elements) |`, `| System gaps (decided or certain) | ${gaps.length} |`, `| Deferred by exception | ${evals.filter(e => e.exception && e.exception !== 'unused' && e.exception !== 'lab').length} |`, `| On lab pages (specimens, not product UI) | ${evals.filter(e => e.exception === 'lab').length} |`, `| In unused files (delete, don't migrate) | ${evals.filter(e => e.exception === 'unused').length} |`, `| Ignored by a reviewer (leave as is) | ${evals.filter(e => !e.exception && effective(e).verdict === 'ignore').length} |`, '');
  const row = (e: ElementEval) => {
    const notes = [...(e.signature ? [`parity ${pct(e.signature.score)}`] : []), ...(e.signature?.mismatched.length ? [`differs: ${e.signature.mismatched.slice(0, 3).join(', ')}`] : e.visualDiffs.length ? [`visual: ${e.visualDiffs.slice(0, 4).join(' ')}`] : []), ...e.a11y, ...(e.decided ? [`decided by ${e.decided.by}`] : [])].join('; ');
    return `| ${e.id} | \`${e.file}:${e.line}\` | ${pct(e.confidence)} | \`${cell(e.snippet).slice(0, 90)}\` | ${cell(notes)} |`;
  };
  const head = ['| Id | Where | Confidence | Element | Notes |', '| --- | --- | --- | --- | --- |'];
  // What each instance becomes, carried content included; anything flagged needs a look before applying.
  const becomes = (items: ElementEval[]) => {
    if (!opts.mapper) return [];
    const lines: string[] = ['<details><summary>What each instance becomes</summary>', ''];
    for (const e of items) {
      const m = opts.mapper(e);
      if (!m?.jsx) continue;
      lines.push(`**${e.id}** \`${e.file}:${e.line}\`${m.flags.length ? ' — check: ' + m.flags.join(' ') : ''}`, '', '```tsx', m.jsx, '```', '');
    }
    lines.push('</details>', '');
    return lines.length > 4 ? lines : [];
  };
  if (ready.length) {
    out.push('## Ready to migrate', '');
    for (const g of groupEvals(ready)) {
      out.push(`### ${g.key} — ${g.items.length} (${pct(g.min)}–${pct(g.max)})`, '');
      if (g.items[0]!.from) out.push(`Import \`${g.items[0]!.use}\` from \`${g.items[0]!.from}\` (or the repo's ui/ wrap).`, '');
      const shot = g.items.map(i => opts.shots?.get(i.id)).find(Boolean);
      if (shot) out.push(`![example](${shot})`, '');
      out.push(...head, ...g.items.map(row), '');
      out.push(...becomes(g.items));
    }
  }
  if (qs.length) {
    out.push('## Questions for a human', '', 'Ask these; do not decide them as an agent. Options are listed best first.', '');
    for (const q of qs) {
      out.push(`### ${q.ask}`, '');
      out.push(`Options: ${q.options.map(o => `**${o.label}**`).join(' · ')}`, '');
      const why = [...new Set(q.items.flatMap(i => i.reasons.filter(r => r.delta < 0).map(r => r.text)))].slice(0, 3);
      if (why.length) out.push(`Why it's uncertain: ${why.join(' ')}`, '');
      out.push(q.kind === 'pattern' ? `Record: \`dsa decide --pattern ${q.key} --use <Component> --props k=v | --keep\`` : `Record per item or for all: \`dsa decide <id> --use <Component> --props k=v | --keep\``, '');
      const shot = q.items.map(i => opts.shots?.get(i.id)).find(Boolean);
      if (shot) out.push(`![example](${shot})`, '');
      out.push(...head, ...q.items.map(row), '');
    }
  }
  if (gaps.length) {
    out.push('## System gaps', '');
    for (const g of groupEvals(gaps)) out.push(`### ${g.key} — ${g.items.length}`, '', g.items[0]!.gap ?? '', '', ...head, ...g.items.map(row), '');
  }
  const unused = evals.filter(e => e.exception === 'unused');
  if (unused.length) {
    out.push('## Unused files', '', 'Nothing the app renders imports these. Do not migrate them; delete them (ask first if unsure), or wire them back in.', '');
    const files = new Map<string, number>();
    for (const e of unused) files.set(e.file, (files.get(e.file) ?? 0) + 1);
    out.push('| File | Elements |', '| --- | --- |', ...[...files].map(([f, n]) => `| \`${f}\` | ${n} |`), '');
  }
  return out.join('\n');
}

export function writePlan(file: string, md: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, md);
}

export { questions, type Question, type QuestionPart } from './questions.js';

/** Decide several elements (a question's members) the same way; one policy when they share a style. */
export async function decideMany(root: string, config: Config, dataDir: string, q: { ids?: string[]; pattern?: string | undefined }, decision: Recommendation, who?: string, note?: string) {
  const opt: Record<string, any> = { decision };
  if (who) opt.who = who;
  if (note) opt.note = note;
  const decided = { by: 'human' as const, decision, note, who, date: new Date().toISOString().slice(0, 10) };
  const threshold = config.review?.threshold ?? DEFAULT_THRESHOLD;
  if (q.pattern) {
    const r = await decide(root, config, dataDir, '', { ...opt, pattern: q.pattern });
    const { evals } = await latestEvals(dataDir);
    await patchLatest(dataDir, evals.filter(e => e.styleKey === q.pattern || e.styleSig === q.pattern).map(e => e.id), { ...decided, by: 'policy' as any }, threshold);
    return [r];
  }
  const out = [];
  // One answer for a whole card is one judgment, however many elements it covers.
  const ids = q.ids ?? [];
  if (ids.length > 1) opt.judgment = `card:${crypto.createHash('sha1').update([...ids].sort().join(' ')).digest('hex').slice(0, 10)}`;
  for (const id of ids) out.push(await decide(root, config, dataDir, id, opt));
  await patchLatest(dataDir, out.map(r => r.e!.id), decided, threshold);
  return out;
}

/**
 * Apply a decisions file: what the published (read-only) dashboard exports after decisions are
 * staged in the browser there. Shape:
 *
 *   { "dsa": "decisions", "version": 1, "decisions": [
 *       { "pattern": "…" | "ids": ["…"], "decision": { "verdict": "replace" | "keep" | "gap" | "ignore", … },
 *         "note": "…", "who": "…" } ] }
 *
 * Every entry is checked before any is written, then each goes through decideMany: exactly what
 * the same decision does in `dsa serve`, label and icon choices included.
 */
export async function applyDecisionFile(root: string, config: Config, dataDir: string, file: string, who?: string) {
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err: any) { throw new Error(`Can't read ${file}: ${err.message}`); }
  if (raw?.dsa !== 'decisions' || !Array.isArray(raw.decisions)) throw new Error(`${file} is not a DSA decisions file (expected {"dsa": "decisions", "decisions": [...]}).`);
  const VERDICTS = ['replace', 'keep', 'gap', 'ignore'];
  const plan = raw.decisions.map((d: any, i: number) => {
    const where = typeof d?.pattern === 'string' && d.pattern ? { pattern: d.pattern } : Array.isArray(d?.ids) && d.ids.length ? { ids: d.ids.map(String) } : null;
    const v = d?.decision?.verdict;
    if (!where) throw new Error(`Decision ${i + 1}: needs "ids" or a "pattern".`);
    if (!VERDICTS.includes(v)) throw new Error(`Decision ${i + 1}: verdict must be one of ${VERDICTS.join(', ')}.`);
    if (v === 'replace' && typeof d.decision.use !== 'string') throw new Error(`Decision ${i + 1}: a replace decision needs "use" (the ${system().label} component).`);
    return { where, decision: d.decision as Recommendation, note: typeof d.note === 'string' && d.note ? d.note : undefined, who: typeof d.who === 'string' ? d.who : who };
  });
  const applied = [];
  for (const p of plan) applied.push({ ...p.where, elements: (await decideMany(root, config, dataDir, p.where, p.decision, p.who, p.note)).reduce((n, r: any) => n + (r.count ?? 1), 0) });
  return applied;
}

/**
 * Reflect a decision (or its removal) in the latest run right away, so the review updates without a
 * re-scan. The decisions file is still the source of truth for the next run.
 */
export async function patchLatest(dataDir: string, ids: string[], decided: ElementEval['decided'] | null, threshold = DEFAULT_THRESHOLD) {
  if (!ids.length) return;
  const store = await openStore(dataDir, 'review');
  try {
    const run = (await store.all<any>('select run_id from runs order by taken_at desc limit 1'))[0]?.run_id;
    if (!run) return;
    for (const id of ids) {
      const row = (await store.all<any>('select data from element_evals where run_id=$1 and id=$2', [run, id]))[0];
      if (!row) continue;
      const e: ElementEval = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      if (decided) e.decided = decided; else delete e.decided;
      e.needsHuman = !e.decided && e.confidence < threshold;
      const eff = e.decided?.decision ?? e;
      await store.exec('update element_evals set data=$3, decided=$4, needs_human=$5, verdict=$6, use_component=$7 where run_id=$1 and id=$2', [run, id, JSON.stringify(e), Boolean(e.decided), e.needsHuman, eff.verdict, eff.use ?? null]);
    }
  } finally { store.close(); }
}

/** Undo: remove decisions for these elements (or the pattern policy and its members' decisions). */
export async function undecide(root: string, config: Config, dataDir: string, q: { ids?: string[]; pattern?: string | undefined }) {
  const { evals } = await latestEvals(dataDir);
  let pattern = q.pattern;
  // An element decided by a pattern policy can only be undone with its pattern.
  if (!pattern) for (const id of q.ids ?? []) { const e = evals.find(x => x.id === id); if (e?.decided?.by === 'policy') pattern = e.styleKey ?? e.styleSig; }
  const members = pattern ? evals.filter(e => e.styleKey === pattern || e.styleSig === pattern) : evals.filter(e => (q.ids ?? []).includes(e.id));
  if (!members.length) throw new Error('Nothing to undo.');
  const fps = new Set(members.map(m => m.fingerprint));
  const files: string[] = [];
  let removed = 0;
  for (const tname of new Set(members.map(m => m.target))) {
    const target = resolveTargets(root, config).find(t => t.name === tname);
    if (!target) continue;
    const df = readDecisions(target.dir, config.rawElementDecisions);
    const before = df.decisions.length + df.policies.length;
    df.decisions = df.decisions.filter(d => !fps.has(d.fingerprint));
    if (pattern) df.policies = df.policies.filter(p => p.match.styleKey !== pattern && p.match.styleSig !== pattern);
    removed += before - (df.decisions.length + df.policies.length);
    writeDecisions(df);
    files.push(df.file);
  }
  await patchLatest(dataDir, members.map(m => m.id), null, config.review?.threshold ?? DEFAULT_THRESHOLD);
  return { ids: members.map(m => m.id), removed, files, pattern };
}
