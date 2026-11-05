import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { federate } from '../../src/engine/federate.js';
import { fixtureCopy, loadConfig } from './fixture.js';

// An app keeps its own dsa.config.json (its routes, flows and skipped folders) and is keyed there, and often
// in the host's config, by its package name, while the run calls it by its target name.

test("an app's own config is merged in, keyed by folder or package name; unknown keys are reported", () => {
  const root = fixtureCopy();
  const dir = path.join(path.dirname(root), 'outside', 'swatches');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@example/swatch-app', dependencies: { '@acme/ds-react': '^4.9.0' } }));
  fs.writeFileSync(path.join(dir, 'dsa.config.json'), JSON.stringify({
    apps: { '@example/swatch-app': { extraRoutes: ['#/own'], flows: [{ name: 'upload', steps: [] }] } },
    scan: { exclude: ['stubs/**', '**/*.test.tsx'] },
  }));
  const cfgFile = path.join(root, 'dsa.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')),
    extraRepos: [{ name: 'swatches', path: '../outside/swatches' }],
    apps: { '@example/swatch-app': { extraRoutes: ['#/host'], tag: false }, 'no-such-app': { screenshots: false } },
  }));
  const { config, unmatched, merged } = federate(root, loadConfig(root).config);
  assert.deepEqual(merged, ['swatches']);
  const app = config.apps!['swatches']!;
  assert.deepEqual(app.extraRoutes, ['#/own', '#/host']);
  assert.equal(app.tag, false);
  assert.equal((app.flows as any[]).length, 1);
  assert.equal(config.apps!['@example/swatch-app'], undefined);
  // Its folder excludes, relative to the host root; a file glob isn't a folder to skip.
  assert.ok(config.exclude?.includes('../outside/swatches/stubs'), JSON.stringify(config.exclude));
  assert.ok(!config.exclude?.some(e => e.includes('test.tsx')));
  assert.deepEqual(unmatched, ['no-such-app']);
  // Merging again changes nothing.
  assert.deepEqual(federate(root, config).config.apps!['swatches']!.extraRoutes, ['#/own', '#/host']);
});
