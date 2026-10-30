import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStore, rowToFinding } from '@snds/dsa/engine';
import { FIXTURES, fixtureCopy, NOW, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { crawlFigma, parseFigmaUrl } from '../src/crawl.js';
import { figmaStage } from '../src/index.js';

// The Figma crawl: library instances and look-alike frames from the standard file endpoints, the
// stage that adds them to a run, and what it says when it can't see anything.

async function findings(dataDir: string) {
  const s = await openStore(dataDir);
  try { return (await s.all<any>('select * from findings order by id')).map(rowToFinding); } finally { s.close(); }
}

test('figma crawler: top-level instances, look-alike frames, recency filter', async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'figma.json'), 'utf8'));
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    if (url.endsWith('/components')) return fx['lib-components'];
    if (url.endsWith('/component_sets')) return fx['lib-sets'];
    if (url.startsWith('/v1/projects/')) return fx.projects;
    if (url === '/v1/files/FILE1') return fx.file1;
    throw new Error('unexpected ' + url);
  };
  const config = { designSystem: { core: { name: 'Core', packages: ['x'] } }, figma: { projectIds: ['P1'], libraries: [{ name: 'Core', fileKey: 'LIB' }] } };
  const r = await crawlFigma(config as any, fetcher, NOW);
  assert.equal(r.filesCrawled, 1);
  assert.deepEqual(r.skipped, ['OLD']);
  const row = (c: string) => r.rows.find(x => x.component === c)!;
  assert.equal(row('Button').instances, 2, 'variants roll up to their component set');
  assert.equal(row('Toast').instances, 1, 'nested instances are not counted');
  assert.equal(row('Toast').lookalikeFrames, 4);
  assert.ok(!urls.includes('/v1/files/OLD'));

  // And it flows into a sampled finding owned by the library (copy the fixture, add a figma section).
  const root = fixtureCopy();
  const cfgFile = path.join(root, 'dsa.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.figma = { projectIds: ['P1'], libraries: [{ name: 'Core', fileKey: 'LIB' }] };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const data = tmp();
  await runPipeline({ root, dataDir: data, git: false, now: NOW, stages: [figmaStage], stageOptions: { figma: fetcher } });
  const f = (await findings(data)).find(x => x.rule === 'figma-lookalike')!;
  assert.equal(f.subject, 'Core|Toast');
  assert.equal(f.scope, 'core');
  assert.equal(f.severity, 'warn', 'sampled signals are capped below serious');
});

test('figma links parse to file, project, and team ids', () => {
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567/Core?node-id=0-1'), { kind: 'file', id: 'AbCdEf1234567' });
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/files/123/project/987654/Checkout'), { kind: 'project', id: '987654' });
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/files/team/555/Acme'), { kind: 'team', id: '555' });
  assert.equal(parseFigmaUrl('https://example.com/nope'), null);
});

test('figma crawl explains itself: no files to scan, unreadable files', async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'figma.json'), 'utf8'));
  const base = async (url: string) => {
    if (url.endsWith('/components')) return fx['lib-components'];
    if (url.endsWith('/component_sets')) return fx['lib-sets'];
    throw new Error('unexpected ' + url);
  };
  // Library only (the setup that showed "crawled" with an empty tab).
  const libOnly = { designSystem: { core: { name: 'Core', packages: ['x'] } }, figma: { libraries: [{ name: 'Core', fileKey: 'LIB' }] } };
  const a = await crawlFigma(libOnly as any, base, NOW);
  assert.equal(a.diag.sources.files, 0);
  assert.equal(a.filesCrawled, 0);
  assert.ok(a.diag.libraries[0].components > 0);

  // One file 404s; the crawl keeps going and records it.
  const withFiles = { ...libOnly, figma: { ...libOnly.figma, projectIds: ['P1'], editedWithinDays: 100000 } };
  const b = await crawlFigma(withFiles as any, async (url: string) => {
    if (url.startsWith('/v1/projects/')) return fx.projects;
    if (url === '/v1/files/FILE1') return fx.file1;
    if (url.startsWith('/v1/files/') && !url.includes('/compon')) throw new Error('Figma 404');
    return base(url);
  }, NOW);
  assert.equal(b.filesCrawled, 1);
  assert.ok(b.diag.files.some(f => f.status === 'error' && /404/.test(f.error!)));
  assert.ok(b.diag.files.find(f => f.key === 'FILE1')!.instances! > 0);
});
