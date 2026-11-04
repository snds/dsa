import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as babelParse } from '@babel/parser';
import { classInfo, visitWithAncestors } from './scanners/features.js';
import { styleKeyOf, styleSigOf, type ElementEval } from './elements.js';
import type { Instance } from './types.js';

/**
 * Learning from the consumer's own migrations (review item 18). The app already shows the answer for
 * many look-alikes: elements it moved to the system, with the props and classes it chose.
 *
 * - Every system-component use in the app is indexed: its props, extra classes, the constant styling it,
 *   its neighbours (the JSX around it) and its state attributes.
 * - Near-truth: a use styled by the same class constant as a raw element (the team migrated that look
 *   once already), or a commit in git history that turned an element with the same classes into a
 *   system component. The recommendation follows it.
 * - A system component right next to the raw element (same parent, a few lines away) of the component
 *   the classifier picked: the raw element takes its size, since siblings share it.
 * - Otherwise the nearest uses by context (same parents, same state, shared layout classes) are offered
 *   as evidence, and their component as an alternative when it differs.
 */

export interface Use {
  component: string;
  file: string;
  line: number;
  props: Record<string, string>;
  classes: string[];
  styleKey?: string | undefined;
  /** The JSX around it, innermost first (its parents' names). */
  parents: string[];
  /** State attributes it carries (aria-pressed, aria-current, data-state…). */
  state: string[];
}

export interface Migration { styleSig: string; component: string; props: Record<string, string>; commit: string; file: string }

export interface PrecedentIndex { uses: Use[]; migrations: Migration[] }

const STATE_ATTR = /^(aria-(pressed|current|selected|expanded|checked)|data-state)$/;
const SKIP_PROP = /^(className|class|key|ref|id|children|style|on[A-Z]\w*|data-(?!state)[\w-]*|aria-label|title)$/;

const nameOf = (n: any): string => n?.type === 'JSXIdentifier' ? n.name : n?.type === 'JSXMemberExpression' ? `${nameOf(n.object)}.${n.property.name}` : '';

/** Index the system-component uses the scanner found, reading each file once. */
export function indexUses(instances: Instance[], absOf: (file: string) => string, aliases: [string, string][] = [], maxFiles = 2000): Use[] {
  const byFile = new Map<string, Instance[]>();
  for (const i of instances) byFile.set(i.file, [...(byFile.get(i.file) ?? []), i]);
  const out: Use[] = [];
  for (const [file, list] of [...byFile].slice(0, maxFiles)) {
    const abs = absOf(file);
    let ast: any;
    try { ast = babelParse(fs.readFileSync(abs, 'utf8'), { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript'] }); } catch { continue; }
    const want = new Map(list.map(i => [`${i.line}\u0001${i.component}`, i]));
    visitWithAncestors(ast.program, (n: any, anc: any[]) => {
      if (n.type !== 'JSXElement') return;
      const o = n.openingElement, nm = nameOf(o.name);
      const line = o.loc?.start.line ?? 0;
      const hit = want.get(`${line}\u0001${nm}`) ?? want.get(`${line}\u0001${nm.split('.').pop()}`);
      if (!hit) return;
      const props: Record<string, string> = {}, state: string[] = [];
      let cls: any = null;
      for (const a of o.attributes) {
        const k = typeof a.name?.name === 'string' ? a.name.name : null;
        if (!k) continue;
        if (k === 'className') cls = a.value;
        if (STATE_ATTR.test(k)) state.push(k);
        if (SKIP_PROP.test(k)) continue;
        const v = a.value, e = v?.type === 'JSXExpressionContainer' ? v.expression : null;
        if (!v) props[k] = 'true';
        else if (v.type === 'StringLiteral') props[k] = v.value;
        else if (e?.type === 'StringLiteral') props[k] = e.value;
        else if (e?.type === 'BooleanLiteral' || e?.type === 'NumericLiteral') props[k] = String(e.value);
      }
      const ci = cls ? classInfo(cls, abs, aliases) : null;
      const parents = anc.filter((a: any) => a?.type === 'JSXElement').map((a: any) => nameOf(a.openingElement.name)).reverse().slice(0, 4);
      out.push({ component: hit.component, file, line, props, classes: ci?.tokens ?? [], styleKey: ci ? styleKeyOf(ci.viaConst) : undefined, parents, state });
    });
  }
  return out;
}

/**
 * Commits that turned a raw element into a system component, from `git log -p` (bounded). A removed line
 * with a literal className and an added line opening a system component in the same hunk are a pair.
 */
export function gitMigrations(dir: string, components: Set<string>, opts: { maxCommits?: number; timeoutMs?: number } = {}): Migration[] {
  if (!components.size) return [];
  let log = '';
  try {
    log = execFileSync('git', ['-C', dir, 'log', `-n${opts.maxCommits ?? 300}`, '-p', '--unified=2', '--no-color', '--format=commit %h', '--', '*.tsx', '*.jsx'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 8000 });
  } catch { return []; }
  const out: Migration[] = [];
  let commit = '', file = '';
  let removed: string[] = [], added: string[] = [];
  const RAW = /<(button|input|select|textarea|a)\b[^>]*\bclassName=(?:"([^"]+)"|\{["'`]([^"'`]+)["'`]\})/;
  const COMP = /<([A-Z][\w.]*)\b([^>]*)/;
  const flush = () => {
    const raws = removed.map(l => RAW.exec(l)).filter(Boolean) as RegExpExecArray[];
    const comps = added.map(l => COMP.exec(l)).filter(m => m && components.has(m[1]!.split('.').pop()!)) as RegExpExecArray[];
    for (let i = 0; i < Math.min(raws.length, comps.length); i++) {
      const sig = styleSigOf((raws[i]![2] ?? raws[i]![3] ?? '').split(/\s+/).filter(Boolean));
      if (!sig) continue;
      const props: Record<string, string> = {};
      for (const m of comps[i]![2]!.matchAll(/\b([a-z][\w-]*)=(?:"([^"]*)"|\{["']([^"']*)["']\})/g)) if (!SKIP_PROP.test(m[1]!)) props[m[1]!] = m[2] ?? m[3] ?? '';
      out.push({ styleSig: sig, component: comps[i]![1]!.split('.').pop()!, props, commit, file });
    }
    removed = []; added = [];
  };
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) { flush(); commit = line.slice(7).trim(); }
    else if (line.startsWith('+++ ')) { flush(); file = line.replace(/^\+\+\+ (b\/)?/, ''); }
    else if (line.startsWith('@@')) flush();
    else if (line.startsWith('-') && !line.startsWith('---')) removed.push(line);
    else if (line.startsWith('+')) added.push(line);
  }
  flush();
  return out;
}

const jaccard = (a: string[], b: string[]) => { const A = new Set(a), B = new Set(b); if (!A.size && !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / (A.size + B.size - n); };
const LAYOUT = /^(-?m[trblxy]?-|w-|min-w|max-w|flex|shrink|grow|self-|justify-|items-|gap-|ml-auto|mr-auto)/;
const describeUse = (u: { component: string; props: Record<string, string> }) => `<${u.component}${Object.entries(u.props).map(([k, v]) => ` ${k}="${v}"`).join('')}>`;

/**
 * Fold precedent into one evaluation (in place). Returns the kind of precedent applied, if any.
 * `parents` are the raw element's JSX parents, innermost first.
 */
export function applyPrecedent(e: ElementEval, idx: PrecedentIndex, threshold: number, parents?: string[]): 'migrated' | 'history' | 'adjacent' | 'neighbours' | undefined {
  if (e.decided) return;
  const allowedProps = (p: Record<string, string>) => Object.fromEntries(Object.entries(p).filter(([k]) => /^(variant|size|type|multiple|orientation)$/.test(k)));
  const follow = (to: { component: string; props: Record<string, string> }, text: string, floor: number) => {
    const props = allowedProps(to.props);
    const before = { verdict: e.verdict, role: e.role, use: e.use, from: e.from, props: e.props, gap: e.gap, confidence: e.confidence };
    const same = e.verdict === 'replace' && e.use === to.component && JSON.stringify(e.props ?? {}) === JSON.stringify({ ...(e.props ?? {}), ...props });
    if (!same) e.alternatives = [before, ...e.alternatives.filter(a => a.use !== to.component)].slice(0, 3);
    const conf = Math.max(e.confidence, floor);
    e.reasons.push({ text, delta: Math.round((conf - e.confidence) * 100) / 100 });
    e.verdict = 'replace'; e.use = to.component; e.props = { ...(e.use === before.use ? e.props ?? {} : {}), ...props };
    if (e.unclear) delete e.unclear;
    e.confidence = Math.round(conf * 100) / 100;
    e.needsHuman = e.confidence < threshold;
  };
  // Near-truth 1: the same class constant, already on a system component in this app.
  const migrated = e.styleKey ? idx.uses.filter(u => u.styleKey === e.styleKey) : [];
  if (migrated.length) {
    const top = majority(migrated);
    follow(top, `Near-truth: the app already migrated the shared style ${e.styleKey} to ${describeUse(top)} (${top.file}:${top.line}${migrated.length > 1 ? `, and ${migrated.length - 1} more` : ''}).`, 0.92);
    return 'migrated';
  }
  // Near-truth 2: a commit that turned an element with these classes into a system component.
  const hist = e.styleSig ? idx.migrations.filter(m => m.styleSig === e.styleSig) : [];
  if (hist.length) {
    const top = majority(hist);
    follow(top, `Near-truth: commit ${top.commit} turned an element with the same classes into ${describeUse(top)} (${top.file}).`, 0.92);
    return 'history';
  }
  if (e.verdict !== 'replace' && e.verdict !== 'unclear') return;
  // A system component right beside it: siblings share their size.
  const beside = idx.uses.filter(u => u.file === e.file && Math.abs(u.line - e.line) <= 3 && (!parents || u.parents[0] === parents[0]));
  const twin = beside.find(u => u.component === e.use);
  if (twin && e.verdict === 'replace') {
    const size = twin.props.size;
    const changed = size !== undefined && e.props?.size !== size;
    if (changed) e.props = { ...(e.props ?? {}), size };
    e.reasons.push({ text: `Next to it (line ${twin.line}) the app already uses ${describeUse(twin)}${changed ? `; take its size (${size})` : ''}.`, delta: 0.02 });
    e.confidence = Math.round(Math.min(0.98, e.confidence + 0.02) * 100) / 100;
    e.needsHuman = e.confidence < threshold;
    return 'adjacent';
  }
  // Nearest uses by context: same parents, same state, shared layout classes.
  const layout = (e.classTokens ?? []).filter(t => LAYOUT.test(t));
  const myParents = parents ?? [];
  const scored = idx.uses.map(u => ({ u, s: 0.5 * jaccard(myParents.slice(0, 3), u.parents.slice(0, 3)) + 0.3 * jaccard(layout, u.classes.filter(t => LAYOUT.test(t))) + 0.2 * (u.file === e.file ? 1 : 0) }))
    .filter(x => x.s >= 0.5).sort((a, b) => b.s - a.s).slice(0, 5);
  if (scored.length < 2) return;
  const top = majority(scored.map(x => x.u));
  const agree = scored.filter(x => x.u.component === top.component).length;
  if (agree < 2) return;
  if (top.component === e.use) e.reasons.push({ text: `The app uses ${top.component} in ${agree} of the ${scored.length} most similar places (${scored.slice(0, 2).map(x => `${x.u.file}:${x.u.line}`).join(', ')}).`, delta: 0 });
  else {
    e.reasons.push({ text: `In ${agree} of the ${scored.length} most similar places the app uses ${describeUse(top)} instead.`, delta: 0 });
    e.alternatives = [...e.alternatives.filter(a => a.use !== top.component), { verdict: 'replace' as const, role: e.role, use: top.component, props: allowedProps(top.props), confidence: Math.min(e.confidence, 0.6) }].slice(0, 3);
  }
  return 'neighbours';
}

/** The most common component + props among precedents (first seen wins a tie). */
function majority<T extends { component: string; props: Record<string, string> }>(xs: T[]): T {
  const key = (x: T) => `${x.component}${JSON.stringify(Object.entries(x.props).filter(([k]) => /^(variant|size)$/.test(k)).sort())}`;
  const n = new Map<string, number>();
  for (const x of xs) n.set(key(x), (n.get(key(x)) ?? 0) + 1);
  return [...xs].sort((a, b) => n.get(key(b))! - n.get(key(a))!)[0]!;
}

/** Build the index for one app: its system-component uses and, when it's a git checkout, its migrations. */
export function buildPrecedent(appDir: string, instances: Instance[], absOf: (file: string) => string, components: Set<string>, aliases: [string, string][] = [], git = true): PrecedentIndex {
  const uses = indexUses(instances, absOf, aliases);
  const migrations = git && fs.existsSync(path.join(appDir)) ? gitMigrations(appDir, components) : [];
  return { uses, migrations };
}
