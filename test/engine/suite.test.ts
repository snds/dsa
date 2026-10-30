import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_DIR, resolveHostRoot } from '../../src/engine/paths.js';
import { runPipeline as runEngine, type RunOptions } from '../../src/engine/pipeline.js';
import { openStore } from '../../src/engine/store.js';
import { loadCatalog, grade, recovered } from '../../src/engine/catalog.js';
import { loadConfig as loadDsaConfig } from '../../src/config.js';
import { engineConfig } from '../../src/engine/from-dsa.js';
import { ACME_PROFILE, ACME_ROOT, openDuckStore } from './setup.js';
import { setSetting } from '../../src/engine/settings.js';
import { rowToFinding, snooze } from '../../src/engine/evaluate.js';
import { renderIssue, syncIssues, MARKER, type Http } from '../../src/engine/issues.js';
import { LockfileResolver } from '../../src/engine/scanners/versions.js';

const ROOT = ACME_ROOT;

/** The engine config for a repo, as `dsa run` builds it (the fixture's analytics-suite config, converted). */
const loadConfig = (root: string) => ({ config: engineConfig(loadDsaConfig({ cwd: root }).config, ACME_PROFILE) });

/** runPipeline as the suite called it: config from the repo, the acme-suite profile, the DuckDB store. */
const runPipeline = (o: Omit<RunOptions, 'config' | 'profile' | 'store'>) =>
  runEngine({ ...o, config: loadConfig(o.root).config, profile: ACME_PROFILE, store: d => openStore(d) });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-'));
const NOW = new Date('2026-10-06T12:00:00Z');

async function findings(dataDir: string) {
  const s = await openDuckStore(dataDir);
  try { return (await s.all<any>('select * from findings order by id')).map(rowToFinding); } finally { s.close(); }
}

test('host root: a clone inside a repo resolves to the parent repo, not itself', () => {
  assert.equal(resolveHostRoot(undefined, APP_DIR), resolveHostRoot(undefined, path.dirname(APP_DIR)));
  assert.notEqual(resolveHostRoot(undefined, APP_DIR), APP_DIR);
  assert.equal(resolveHostRoot(ROOT), ROOT);
});

test('thresholds: grading and hysteresis', () => {
  const c = loadCatalog();
  const cu = c.byId.get('correct_use_rate')!; // up, watch 90, act 75, close 92
  assert.equal(grade(cu, 70), 'act');
  assert.equal(grade(cu, 85), 'watch');
  assert.equal(grade(cu, 91), null);
  assert.equal(recovered(cu, 91), false, 'inside the band: stays open');
  assert.equal(recovered(cu, 93), true);
  const vc = c.byId.get('version_currency')!; // down, watch 1, act 2
  assert.equal(grade(vc, 2), 'act');
  assert.equal(grade(vc, 0), null);
});

test('end to end on the fixture monorepo', async () => {
  const data = tmp();
  const res = await runPipeline({ root: ROOT, dataDir: data, git: false, now: NOW });
  const byTarget = (t: string) => res.data.instances.filter(i => i.target === t);
  // React, Vue, Angular (file + inline template) all scanned.
  assert.equal(byTarget('checkout').length, 9);
  assert.equal(byTarget('reporting').length, 7, 'Vue <select> must not be mistaken for the DS Select');
  assert.equal(byTarget('admin').length, 9);
  assert.ok(byTarget('admin').some(i => i.component === 'Banner' && i.overrides.includes('className')), 'inline Angular template');
  assert.equal(res.data.lookalikes.filter(l => l.component === 'Select').length, 12);
  // Lockfile resolution, including a child library behind core.
  const v = (t: string, p: string) => res.data.versions.find(r => r.target === t && r.pkg === p)!;
  assert.equal(v('billing', '@acme/ds-react').resolved, '4.9.0');
  assert.equal(v('reporting', '@acme/ds-vue').majorsBehind, 2);
  assert.equal(v('Commerce kit', '@acme/ds-react').resolved, '4.2.0');

  const fs_ = await findings(data);
  const rules = fs_.map(f => `${f.rule}:${f.subject}`).sort();
  assert.deepEqual(rules, [
    'coverage-gap:Select',
    'deprecated:billing',
    'misuse-cluster:DataTable|className',
    'token-compliance:billing',
    'version-currency:Commerce kit',
    'version-currency:billing',
    'version-currency:reporting',
  ]);
  const cluster = fs_.find(f => f.rule === 'misuse-cluster')!;
  assert.equal(cluster.scope, 'core', 'clustered misuse routes to the component owner');
  assert.equal(cluster.repo, 'acme/design-system');
  assert.deepEqual([...cluster.affected].sort(), ['admin', 'billing', 'checkout', 'reporting']);
  const kit = fs_.find(f => f.subject === 'Commerce kit')!;
  assert.equal(kit.scope, 'child');
  assert.ok(kit.affected.includes('checkout'), 'child lag lists its downstream consumers');
  assert.ok(fs.existsSync(path.join(data, 'dsa.duckdb')));
});

test('changing the cluster threshold re-routes misuse and logs the change', async () => {
  const data = tmp();
  await runPipeline({ root: ROOT, dataDir: data, git: false, now: NOW });
  const { config } = loadConfig(ROOT);
  const store = await openDuckStore(data);
  await setSetting(store, loadCatalog(), config, data, 'misuse_cluster_threshold', 5, 'test');
  const log = await store.all<any>('select key, new_value, note from settings_log');
  store.close();
  assert.equal(log.length, 1);
  await runPipeline({ root: ROOT, dataDir: data, git: false, now: new Date(NOW.getTime() + 7 * 864e5) });
  const fs_ = await findings(data);
  assert.equal(fs_.find(f => f.rule === 'misuse-cluster')!.status, 'resolved');
  const isolated = fs_.filter(f => f.rule === 'misuse-isolated' && f.status === 'open');
  assert.equal(isolated.length, 4, 'below the new threshold each consumer owns its fix');
  assert.ok(isolated.every(f => f.scope === 'consumer' && (f.settingsUsed as any).misuse_cluster_threshold === 5));
  // The Select coverage gap (3 consumers) also dissolves into per-consumer look-alike findings.
  assert.equal(fs_.find(f => f.rule === 'coverage-gap')!.status, 'resolved');
});

test('snooze needs a reason', async () => {
  const data = tmp();
  await runPipeline({ root: ROOT, dataDir: data, git: false, now: NOW });
  const store = await openDuckStore(data);
  try {
    const [f] = await store.all<any>('select id from findings limit 1');
    await assert.rejects(() => snooze(store, f.id, 30, '  '));
    await snooze(store, f.id, 30, 'waiting on Q4 rebase');
    const [row] = await store.all<any>('select status, snooze_reason from findings where id=$1', [f.id]);
    assert.equal(row.status, 'snoozed');
  } finally { store.close(); }
});

test('issues: deterministic render, marker, and sync plan', async () => {
  const data = tmp();
  await runPipeline({ root: ROOT, dataDir: data, git: false, now: NOW });
  const fs_ = await findings(data);
  const f = fs_.find(x => x.rule === 'misuse-cluster')!;
  const a = renderIssue(f), b = renderIssue(f);
  assert.deepEqual(a, b);
  assert.ok(a.title.startsWith(`[${f.id}] `));
  assert.ok(a.body.includes(MARKER(f.id)));

  const { config } = loadConfig(ROOT);
  const calls: string[] = [];
  const existingBody = a.body.replace('Evidence', 'Old evidence');
  const http: Http = async (method, url) => {
    calls.push(`${method} ${url.split('?')[0]}`);
    if (method === 'GET' && url.startsWith('/repos/acme/design-system/issues')) return [{ number: 7, state: 'open', title: a.title, body: existingBody, html_url: 'https://github.com/acme/design-system/issues/7' }];
    if (method === 'GET') return [];
    return { html_url: 'https://github.com/x/y/issues/1' };
  };
  const pushed = new Set(fs_.map(x => x.id));
  const plan = await syncIssues(fs_, pushed, config, http, false);
  assert.ok(plan.actions.some(x => x.kind === 'update' && x.id === f.id && x.number === 7));
  assert.ok(plan.actions.some(x => x.kind === 'create' && x.repo === 'acme/commerce-kit'));
  assert.ok(!calls.some(c => c.startsWith('POST') || c.startsWith('PATCH')), 'dry run makes no writes');
  const done = await syncIssues(fs_, pushed, config, http, true);
  assert.ok(calls.some(c => c === 'PATCH /repos/acme/design-system/issues/7'));
  assert.equal(done.urls.get(f.id), 'https://github.com/acme/design-system/issues/7');
  // Budget: findings outside the pushed set are not created.
  const capped = await syncIssues(fs_, new Set(), config, http, false);
  assert.ok(capped.actions.every(x => x.kind !== 'create'));
});

test('lockfiles: pnpm and yarn v1', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  apps/web:\n    dependencies:\n      '@acme/ds-react':\n        specifier: ^5.0.0\n        version: 5.2.1(react@18.3.1)\n`);
  assert.equal(new LockfileResolver(dir).resolve(path.join(dir, 'apps/web'), '@acme/ds-react', '^5.0.0'), '5.2.1');
  const y = tmp();
  fs.writeFileSync(path.join(y, 'yarn.lock'), `"@acme/ds-react@^4.0.0", "@acme/ds-react@^4.1.0":\n  version "4.3.0"\n  resolved "x"\n`);
  assert.equal(new LockfileResolver(y).resolve(y, '@acme/ds-react', '^4.1.0'), '4.3.0');
});

// ---------- Tailwind/shadcn-style hosts: shims, leaky classNames, internal consumers, pins ----------
import { execFileSync } from 'node:child_process';

function write(root: string, files: Record<string, string>) {
  for (const [f, c] of Object.entries(files)) { const p = path.join(root, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); }
}

function shadcnHost(): string {
  const root = tmp();
  write(root, {
    'package.json': JSON.stringify({ name: 'host', private: true, workspaces: ['packages/*', 'apps/*'] }),
    'packages/ui/package.json': JSON.stringify({ name: '@x/ui', version: '0.0.0' }),
    'packages/tokens/package.json': JSON.stringify({ name: '@x/tokens', version: '0.0.0' }),
    'packages/tokens/semantic.css': ':root{--color-primary: var(--sem-primary); --color-muted-foreground: var(--sem-muted);}',
    'packages/lint/tier.json': JSON.stringify({ prefixes: ['bg', 'text', 'border'], hues: ['blue', 'red'], steps: ['500', '600'], literal_palette: ['white'], compat_prefixes: ['x'] }),
    'apps/docs/package.json': JSON.stringify({ name: 'docs', dependencies: { '@x/ui': '*' } }),
    'apps/docs/src/page.tsx': `import { Button } from '@x/ui/button';\nexport const P = () => <><Button className="bg-blue-500" /><button /><button /><button /><button /><button /></>;\n`,
    'dsa.config.json': JSON.stringify({
      designSystem: { core: { name: 'X', packages: ['@x/ui', '@x/tokens'] }, children: [{ name: 'Proto', packages: [], path: '../proto', pin: { file: 'x.pin' } }] },
      tailwind: { tierLeakageSpec: 'packages/lint/tier.json', semanticCss: 'packages/tokens/semantic.css' },
      internalConsumers: ['docs'],
    }),
  });
  return root;
}

test('shims, wrappers, and Tailwind-aware overrides in a sibling child repo', async () => {
  const host = shadcnHost();
  const proto = path.join(path.dirname(host), 'proto');
  write(proto, {
    'package.json': JSON.stringify({ name: 'proto', dependencies: { '@x/ui': 'file:../host/packages/ui' } }),
    'tsconfig.json': '{ // jsonc\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }',
    'src/ui/button.tsx': 'export * from "@x/ui/button";\n',
    'src/ui/select.tsx': 'import { SelectTrigger as Sys } from "@x/ui/select";\nexport function SelectTrigger(props: any) { return <Sys {...props} className="h-8" />; }\n',
    'src/ui/index.ts': 'export { Button } from "./button";\n',
    'src/App.tsx': [
      "import { Button } from '@/ui/button';",
      "import { SelectTrigger } from './ui/select';",
      "import { Button as B2 } from './ui';",
      'export const App = () => (<div>',
      '  <Button className="mt-2 text-muted-foreground" />',
      '  <Button className={cn("p-2", ok && "bg-red-600")} />',
      '  <Button className="w-[420px]" />',
      '  <Button className="bg-[#ff0000]" />',
      '  <SelectTrigger />',
      '  <B2 />',
      '  <span className="bg-white text-primary" />',
      '</div>);',
    ].join('\n'),
    'src/App.test.tsx': "import { Button } from '@/ui/button';\nexport const T = () => <Button className=\"bg-blue-500\" />;\n",
  });
  const data = tmp();
  const res = await runPipeline({ root: host, dataDir: data, git: false, now: NOW });
  const inst = res.data.instances.filter(i => i.target === 'Proto');
  // 4 Buttons + 1 B2 via shims, 1 SelectTrigger wrapper usage, 1 Sys inside the wrapper; the test file is skipped.
  assert.equal(inst.filter(i => i.component === 'Button').length, 5);
  assert.equal(inst.filter(i => i.component === 'SelectTrigger').length, 2);
  const overridden = inst.filter(i => i.overrides.length);
  assert.equal(overridden.length, 2, 'only palette leaks and arbitrary colors count; layout classes and spreads in wrappers do not');
  // Tokens: bg-red-600, bg-[#ff0000], bg-white are raw; text-muted-foreground, text-primary are semantic.
  const tok = res.data.tokens.filter(t => t.target === 'Proto' && t.file.endsWith('App.tsx'))[0]!;
  assert.deepEqual([tok.rawValues, tok.tokenRefs], [3, 2]);
  // Internal consumers are scored but can't form a cluster on their own.
  const fs_ = await findings(data);
  assert.ok(!fs_.some(f => f.rule === 'coverage-gap'));
  assert.ok(fs_.some(f => f.rule === 'lookalike' && f.subject === 'docs|Button'));
  // Child-library findings are scoped as child, and sibling-repo paths read as "proto/src/...".
  assert.ok(fs_.filter(f => f.affected.includes('Proto')).every(f => f.scope === 'child'));
  assert.ok(inst.every(i => i.file.startsWith('proto/')));
});

test('SHA pins: days and commits behind core main', async () => {
  const host = shadcnHost();
  const proto = path.join(path.dirname(host), 'proto');
  write(proto, { 'package.json': JSON.stringify({ name: 'proto' }) });
  const git = (args: string[], date: string) => execFileSync('git', ['-C', host, ...args], { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main'], '2026-09-01T00:00:00Z');
  git(['add', '-A'], '2026-09-01T00:00:00Z');
  git(['commit', '-qm', 'one'], '2026-09-01T00:00:00Z');
  const pinned = git(['rev-parse', 'HEAD'], '2026-09-01T00:00:00Z');
  fs.writeFileSync(path.join(host, 'packages/ui/new.txt'), 'x');
  git(['add', '-A'], '2026-10-06T00:00:00Z');
  git(['commit', '-qm', 'two'], '2026-10-06T00:00:00Z');
  fs.writeFileSync(path.join(proto, 'x.pin'), pinned + '\n');
  const data = tmp();
  const res = await runPipeline({ root: host, dataDir: data, git: false, now: NOW });
  const pin = res.data.versions.find(v => v.pkg === 'pin:x.pin')!;
  assert.equal(pin.daysBehind, 35);
  assert.equal(pin.commitsBehind, 1);
  const f = (await findings(data)).find(x => x.rule === 'pin-currency')!;
  assert.equal(f.severity, 'serious', '35 days is past the 30-day act threshold');
});

// ---------- Settings: link parsing, saving, secrets never in config ----------

test('per-app measures: look-alikes off, token skip globs, versions off', async () => {
  const root = path.join(tmp(), 'repo');
  fs.cpSync(ROOT, root, { recursive: true });
  const cfgFile = path.join(root, 'dsa.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.apps = { reporting: { lookalikes: false, versions: false }, checkout: { tokenSkip: ['cart.css'] } };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const res = await runPipeline({ root, dataDir: path.join(root, '.dsa'), git: false, now: NOW });
  assert.equal(res.data.lookalikes.filter(l => l.target === 'reporting').length, 0);
  assert.ok(res.data.instances.some(i => i.target === 'reporting'), 'components still measured');
  assert.ok(!res.data.versions.some(v => v.target === 'reporting'));
  assert.ok(!res.data.tokens.some(t => t.target === 'checkout' && t.file.endsWith('cart.css')));
  assert.ok(res.data.lookalikes.some(l => l.target !== 'reporting'), 'other apps unaffected');
});

test('glob matching for skip lists', async () => {
  const { globMatch } = await import('../../src/engine/paths.js');
  assert.ok(globMatch('before-tokens.css', 'stories/review/before-tokens.css'));
  assert.ok(globMatch('stories/review/*.tsx', 'stories/review/palette-review.tsx'));
  assert.ok(!globMatch('stories/review/*.tsx', 'stories/review/x/a.tsx'));
  assert.ok(globMatch('stories/**/*.css', 'stories/a.css'));
  assert.ok(!globMatch('Theme.stories.tsx', 'stories/XTheme.stories.tsx'));
});

test('element map from the design system + per-app exceptions file', async () => {
  const root = path.join(tmp(), 'repo');
  fs.cpSync(ROOT, root, { recursive: true });
  fs.mkdirSync(path.join(root, 'packages/lint'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/lint/raw-elements.json'), JSON.stringify({ elements: {
    button: { use: 'Button', from: 'x' }, select: { use: 'Picker', from: 'x' },
    input: { use: 'TextField', from: 'x', types: { checkbox: { use: 'Toggle', from: 'x' } }, allowTypes: ['hidden'] },
  } }));
  const cfgFile = path.join(root, 'dsa.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.rawElements = 'packages/lint/raw-elements.json';
  delete cfg.lookalikes;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const base = await runPipeline({ root, dataDir: path.join(root, '.d1'), git: false, now: NOW });
  assert.ok(base.data.lookalikes.some(l => l.component === 'Picker'), 'components come from the map');
  assert.ok(!base.data.lookalikes.some(l => l.element === 'table'), 'elements outside the map are not counted');
  const billing = base.data.lookalikes.filter(l => l.target === 'billing');
  assert.ok(billing.length > 0);

  // Billing defers its whole src folder, past the review date.
  fs.mkdirSync(path.join(root, 'apps/billing/docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/billing/docs/raw-elements.exceptions.json'), JSON.stringify({
    temporary: [{ paths: ['src/**'], owner: 'FE', review: '2026-01-01' }], allow: [],
  }));
  const res = await runPipeline({ root, dataDir: path.join(root, '.d2'), git: false, now: NOW });
  assert.equal(res.data.lookalikes.filter(l => l.target === 'billing').length, 0);
  const note = res.notes.find(n => n.startsWith('billing:'))!;
  assert.match(note, new RegExp(`${billing.length} look-alike`));
  assert.match(note, /Past its review date/);
});

test('target-relative paths for apps inside and outside the host root', async () => {
  const { targetRelative, displayPath } = await import('../../src/engine/paths.js');
  const root = '/w/ds', sib = '/w/proto', inner = '/w/ds/apps/storybook';
  assert.equal(targetRelative(root, displayPath(root, '/w/proto/src/a.tsx', sib), sib), 'src/a.tsx');
  assert.equal(targetRelative(root, displayPath(root, '/w/ds/apps/storybook/stories/b.css', inner), inner), 'stories/b.css');
});

// ---------- element evaluator ----------
async function evalSnippet(code: string, extraFiles: Record<string, string> = {}) {
  const { parse } = await import('@babel/parser');
  const { reactFeatures, visitWithAncestors, resetFeatureCaches } = await import('../../src/engine/scanners/features.js');
  const { classify } = await import('../../src/engine/classify.js');
  resetFeatureCaches();
  const dir = tmp();
  for (const [f, s] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, f), s);
  const file = path.join(dir, 'x.tsx');
  fs.writeFileSync(file, code);
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  let hit: any = null;
  visitWithAncestors(ast.program, (n: any, anc: any[]) => {
    if (!hit && n.type === 'JSXElement' && /^(button|input|table|select|textarea|dialog)$/.test(n.openingElement.name.name)) hit = reactFeatures(n, [...anc], code, file, []);
  });
  return classify(hit);
}

test('evaluator: icon button, size from the density token, high confidence', async () => {
  const e = await evalSnippet(`export const A = () => <button aria-label="Close" onClick={close} className="h-(--acme-control-h-sm) w-(--acme-control-h-sm) hover:bg-accent"><Icon name="close" /></button>;`);
  assert.equal(e.role, 'icon-button');
  // icon-button maps to today's API on main: Button with Button's icon-* sizes (IconButton is only on branches).
  assert.equal(e.use, 'Button');
  assert.deepEqual(e.props, { variant: 'ghost', size: 'icon-sm' });
  assert.ok(e.confidence >= 0.9, String(e.confidence));
});

test('evaluator: link through an imported, aliased class constant', async () => {
  const e = await evalSnippet(
    `import { PLUS } from './styles';\nconst JUMP = PLUS;\nexport const A = () => <button className={JUMP}><Icon name="add" /> Link</button>;`,
    { 'styles.ts': `export const PLUS = 'plus-noun-link text-primary border-b border-transparent hover:border-current';` });
  assert.equal(e.role, 'link-button');
  assert.ok(e.reasons.some(r => /shared style PLUS \(via JUMP\)/.test(r.text)), JSON.stringify(e.reasons));
  assert.ok(e.visualDiffs.includes('border-b'), 'house underline style is a visual difference');
  assert.ok(e.confidence < 0.9, 'visual differences keep it under the human threshold');
});

test('evaluator: hover-only underline is not a link at rest', async () => {
  const e = await evalSnippet(`export const A = () => <button className="text-xs text-muted-foreground hover:text-foreground hover:underline">Clear</button>;`);
  assert.notEqual(e.ruleId, 'button.link');
  assert.ok(e.confidence < 0.9);
});

test('evaluator: a button wrapping a list row is Item rendered as a button, not a gap or a plain Button', async () => {
  // Was "a system gap" until the 2026-10-13 audit: Acme Item takes render={<button />}.
  const e = await evalSnippet(`export const A = () => <button className="w-full text-left"><p className="font-medium">{name}</p><div className="text-xs">{meta}</div></button>;`);
  assert.equal(e.verdict, 'replace');
  assert.equal(e.role, 'clickable-region');
  assert.equal(e.use, 'Item');
});

test('evaluator: toggle pattern from a selected condition in a map', async () => {
  const e = await evalSnippet(`export const A = () => <div>{tabs.map(k => <button key={k} onClick={() => set(k)} className={clsx('px-2 py-1 text-xs', cur === k ? 'bg-selected' : 'hover:bg-accent')}>{k}</button>)}</div>;`);
  // One of a set picked by equality: segmented (ToggleGroupItem), not a pressed toggle.
  assert.equal(e.role, 'segmented');
  assert.ok(e.reasons.some(r => r.text.includes('.map()')));
});

test('evaluator: tables, inputs, dialogs', async () => {
  assert.equal((await evalSnippet(`const A = () => <table><thead><tr><th onClick={sort}>Name</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{r.n}</td></tr>)}</tbody></table>;`)).use, 'DataTable');
  const t = await evalSnippet(`const A = () => <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{r.a}</td><td>{r.b}</td></tr>)}</tbody></table>;`);
  assert.ok(t.confidence < 0.9 && t.alternatives.length, 'mapped, non-interactive: a judgment call');
  // AmountInput is for money and quantities; any other number field is Input type="number" (audit item 10).
  const n = await evalSnippet(`const A = () => <input type="number" value={v} onChange={c} />;`);
  assert.equal(n.role, 'text-input');
  assert.equal(n.props?.type, 'number');
  const q = await evalSnippet(`const A = () => <input type="number" value={moq} onChange={setMoq} />;`);
  assert.equal(q.role, 'number-input');
  const d = await evalSnippet(`const A = () => { ref.current.showModal(); return <dialog ref={ref} />; };`);
  assert.equal(d.role, 'native-dialog');
});

test('decisions: agents cannot decide below the threshold; human decisions stick and calibrate', async () => {
  const { decide, latestEvals } = await import('../../src/engine/review.js');
  const { calibrate } = await import('../../src/engine/classify.js');
  const root = path.join(tmp(), 'repo');
  fs.cpSync(ROOT, root, { recursive: true });
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { config } = loadConfig(root);
  const { evals } = await latestEvals(data, 'reporting');
  const low = evals.find(e => e.needsHuman)!;
  assert.ok(low, 'Vue template selects lack context, so they need a human');
  await assert.rejects(decide(root, config, data, low.id, { accept: true, by: 'agent' }), /below the 90% review threshold/);
  const r = await decide(root, config, data, low.id, { use: 'NativeSelect', by: 'human', who: 'Sean', note: 'native picker on purpose' });
  assert.equal(r.entry.agreed, false);
  const file = path.join(root, 'apps/reporting/docs/raw-elements.decisions.json');
  assert.ok(fs.existsSync(file), 'decisions live with the app');
  await runPipeline({ root, dataDir: data, git: false, now: new Date(NOW.getTime() + 864e5) });
  const after = (await latestEvals(data, 'reporting')).evals.find(e => e.fingerprint === low.fingerprint)!;
  assert.equal(after.decided?.decision.use, 'NativeSelect');
  assert.equal(after.needsHuman, false);
  // Calibration: a rule humans keep overriding loses confidence.
  const c = calibrate({ ...after, confidence: 0.92, reasons: [] } as any, { n: 10, agree: 3 });
  assert.ok(c.confidence < 0.6 && c.calibrated?.n === 10, String(c.confidence));
});

test('reach: unused files, render gates, and the control that opens them', async () => {
  const { buildGraph, reachFor } = await import('../../src/engine/reach.js');
  const { reactFeatures, visitWithAncestors } = await import('../../src/engine/scanners/features.js');
  const { parse } = await import('@babel/parser');
  const app = tmp();
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.mkdirSync(path.join(app, 'labs'), { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<script type="module" src="/src/main.tsx"></script>');
  // lab-main, not lab: on a case-insensitive disk (macOS) lab.tsx and Lab.tsx are one file.
  fs.writeFileSync(path.join(app, 'labs/lab.html'), '<script type="module" src="/src/lab-main.tsx"></script>');
  fs.writeFileSync(path.join(app, 'src/main.tsx'), `import { App } from './App';\n`);
  fs.writeFileSync(path.join(app, 'src/lab-main.tsx'), `import { Lab } from './Lab';\n`);
  fs.writeFileSync(path.join(app, 'src/Lab.tsx'), `export function Lab() { return <button>Lab</button>; }\n`);
  fs.writeFileSync(path.join(app, 'src/Old.tsx'), `export function Old() { return <button>Old</button>; }\n`);
  fs.writeFileSync(path.join(app, 'src/Media.tsx'), `export function Media({ open, onClose }) {\n  if (!open) return null;\n  return <div><button className="x">Pick image</button><button onClick={onClose}>Cancel</button></div>;\n}\n`);
  fs.writeFileSync(path.join(app, 'src/App.tsx'), `import { useState } from 'react';\nimport { Media } from './Media';\nexport function App() {\n  const [mediaOpen, setMediaOpen] = useState(false);\n  const [editing, setEditing] = useState(false);\n  return <main>\n    <button onClick={() => setMediaOpen(true)}>Add image</button>\n    <Media open={mediaOpen} onClose={() => setMediaOpen(false)} />\n    {editing ? <input className="raw" /> : <button onDoubleClick={() => setEditing(true)}>Rename</button>}\n  </main>;\n}\n`);
  const g = buildGraph(app);
  const featsAt = (file: string, tag: string, nth = 0) => {
    const src = fs.readFileSync(file, 'utf8');
    const ast = parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    const hits: any[] = [];
    visitWithAncestors(ast.program, (n: any, anc: any[]) => { if (n.type === 'JSXElement' && n.openingElement.name.name === tag) hits.push({ f: reactFeatures(n, [...anc], src, file, []), line: n.loc.start.line }); });
    return hits[nth];
  };
  assert.equal(reachFor(g, path.join(app, 'src/Old.tsx'), 1, []).status, 'unused');
  assert.equal(reachFor(g, path.join(app, 'src/Lab.tsx'), 1, []).status, 'page', 'a lab page is an entry too');
  const pick = featsAt(path.join(app, 'src/Media.tsx'), 'button');
  const r = reachFor(g, path.join(app, 'src/Media.tsx'), pick.line, pick.f.context.gates);
  assert.equal(r.status, 'gated');
  assert.deepEqual(r.steps.map(s => s.label), ['Add image'], r.why);
  const input = featsAt(path.join(app, 'src/App.tsx'), 'input');
  const r2 = reachFor(g, path.join(app, 'src/App.tsx'), input.line, input.f.context.gates);
  assert.deepEqual(r2.steps.map(s => [s.label, s.event]), [['Rename', 'dblclick']], r2.why);
});

test('mapping: each instance keeps its label, icon, handler, and layout classes; judgment calls are flagged', async () => {
  const { mapInstance } = await import('../../src/engine/mapping.js');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/app.css'), '.plus-noun-link { text-underline-offset: 4px; }\n');
  const file = path.join(dir, 'src/View.tsx');
  fs.writeFileSync(file, `const L = "plus-noun-link inline-flex text-primary";\nexport const V = () => (<div>\n  <button type="button" onClick={addAlias} className={L} aria-label="Add alias">\n    <Icon name="add" size="sm" /> Alias\n  </button>\n  <a href="/x" className="ml-2 text-primary">Open <Badge>3</Badge></a>\n</div>);\n`);
  const base: any = { target: 'app', fingerprint: 'x', confidence: 0.95, reasons: [], alternatives: [], verdict: 'replace', role: 'button' };
  const btn = { ...base, id: 'E-1', file: 'app/src/View.tsx', line: 3, col: 3, element: 'button', classTokens: ['plus-noun-link', 'inline-flex', 'text-primary'] };
  const m = mapInstance(btn, file, dir, { verdict: 'replace', role: 'button', use: 'Button', props: { variant: 'link', size: 'default' } }, { component: 'Button', tag: 'button', childSlots: ['icon'], defaults: { variant: 'default', size: 'default' } });
  assert.equal(m.jsx, '<Button variant="link" type="button" onClick={addAlias} aria-label="Add alias">\n  <Icon name="add" /> Alias\n</Button>');
  assert.deepEqual(m.had, { label: 'Alias', leading: 'add', trailing: undefined, iconOnly: false });
  assert.ok(m.flags.some(f => f.includes('plus-noun-link') && f.includes('app.css')), m.flags.join('\n'));
  assert.ok(m.dropped.some(d => d.includes('size="sm"')));
  // Same instance, every icon swapped and the label set for all.
  const m2 = mapInstance(btn, file, dir, { verdict: 'replace', role: 'button', use: 'Button', props: {}, content: { leading: { icon: 'edit' }, label: { text: 'Edit' } } }, { component: 'Button', tag: 'button', childSlots: ['icon'] });
  assert.ok(m2.jsx.includes('<Icon name="edit" /> Edit'), m2.jsx);
  // An anchor becomes Button render={<a … />} (Acme uses render, not asChild); layout classes stay; nested elements are flagged.
  const a = { ...base, id: 'E-2', file: 'app/src/View.tsx', line: 6, col: 3, element: 'a', classTokens: ['ml-2', 'text-primary'] };
  const m3 = mapInstance(a, file, dir, { verdict: 'replace', role: 'link', use: 'Button', props: { variant: 'link' } }, { component: 'Button', tag: 'button' });
  assert.equal(m3.jsx, '<Button variant="link" nativeButton={false} render={<a href="/x" />} className="ml-2">\n  Open <Badge>3</Badge>\n</Button>');
  assert.ok(!m3.jsx.includes('asChild') && !m3.flags.some(f => f.includes('asChild')), m3.flags.join('\n'));
  assert.equal(m3.status, 'check');
});

test('decide --file: decisions staged on the published dashboard apply as in dsa serve, all or nothing', async () => {
  const { applyDecisionFile, latestEvals } = await import('../../src/engine/review.js');
  const root = path.join(tmp(), 'repo');
  fs.cpSync(ROOT, root, { recursive: true });
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { config } = loadConfig(root);
  const { evals } = await latestEvals(data, 'reporting');
  const [r1, r2] = evals.filter(e => e.verdict === 'replace' && e.use && !e.exception);
  assert.ok(r1 && r2, 'fixture has two replaceable elements');
  const file = path.join(tmp(), 'dsa-decisions.json');

  // One bad entry: nothing is written.
  fs.writeFileSync(file, JSON.stringify({ dsa: 'decisions', version: 1, decisions: [
    { ids: [r1.id], decision: { verdict: 'replace', role: r1.role, use: r1.use, props: r1.props ?? {} } },
    { ids: [r2.id], decision: { verdict: 'replace', role: r2.role } },
  ] }));
  await assert.rejects(applyDecisionFile(root, config, data, file), /Decision 2: a replace decision needs "use"/);
  assert.equal((await latestEvals(data, 'reporting')).evals.find(e => e.id === r1.id)?.decided, undefined);
  await assert.rejects(applyDecisionFile(root, config, data, path.join(tmp(), 'nope.json')), /Can't read/);

  // A valid file: a replace with a note, and an ignore (which the --use/--keep/--gap flags can't express).
  fs.writeFileSync(file, JSON.stringify({ dsa: 'decisions', version: 1, decisions: [
    { ids: [r1.id], decision: { verdict: 'replace', role: r1.role, use: r1.use, props: r1.props ?? {} }, note: 'approved on Pages' },
    { ids: [r2.id], decision: { verdict: 'ignore', role: r2.role } },
  ] }));
  const applied = await applyDecisionFile(root, config, data, file, 'Sean');
  assert.equal(applied.length, 2);
  const after = (await latestEvals(data, 'reporting')).evals;
  const d1 = after.find(e => e.id === r1.id)!.decided!;
  assert.equal(d1.decision.use, r1.use);
  assert.equal(d1.note, 'approved on Pages');
  assert.equal(d1.who, 'Sean');
  assert.equal(after.find(e => e.id === r2.id)!.decided!.decision.verdict, 'ignore');
});

test('the element a component draws as (render prop) is not a look-alike; slot content is', async () => {
  const host = shadcnHost();
  write(host, {
    'apps/docs/src/items.tsx': [
      "import { Item } from '@x/ui/item';",
      'export const L = () => (<>',
      '  <Item render={<button type="button" />}>Open</Item>',
      '  <Item render={<button type="button" disabled />}>Disabled</Item>',
      '  <Item variant="outline" render={<button />} />',
      '  <button>Plain</button>',
      '  <Item action={<button>Slot content</button>}>Row</Item>',
      '</>);',
    ].join('\n'),
  });
  const res = await runPipeline({ root: host, dataDir: tmp(), git: false, now: NOW });
  const rows = res.data.lookalikes.filter(l => l.target === 'docs' && l.element === 'button');
  // page.tsx has 5 plain buttons; items.tsx adds the child and the slot content, not the three in render.
  assert.equal(rows.length, 7);
  assert.equal(rows.filter(l => l.file.endsWith('items.tsx')).length, 2);
});
