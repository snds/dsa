import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addToLedger, readLedger, recordsFor, type LedgerRec } from '../src/ledger.js';

// The ledger keeps what each element rendered with, by file and that file's source hash: an older version's
// records are dropped, and each element keeps up to three, one per URL, ones with a size first.

const rec = (src: string, url: string, w = 10): LedgerRec => ({ src, url, at: 0, w, h: w, owner: { name: 'Tile', props: { n: 1 }, cut: false }, ancestors: [] });

test('records are kept per file hash, three per element, one per URL', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-ledger-')), 'ledger.json');
  let hash = 'a';
  const hashOf = () => hash;
  assert.equal(addToLedger(file, [rec('app/src/Tile.jsx:3:5', 'http://x/#/a', 0), rec('app/src/Tile.jsx:3:5', 'http://x/#/a')], hashOf), 1);
  addToLedger(file, ['b', 'c', 'd'].map(p => rec('app/src/Tile.jsx:3:5', `http://x/#/${p}`)), hashOf);
  const now = readLedger(file, hashOf);
  assert.equal(now['app/src/Tile.jsx:3:5']!.length, 3);
  // Another node of the same line answers for it.
  assert.equal(recordsFor(now, 'app/src/Tile.jsx:3:9').length, 3);
  assert.equal(recordsFor(now, 'app/src/Tile.jsx:4:1').length, 0);
  // Its file changed: nothing from before counts.
  hash = 'b';
  assert.deepEqual(readLedger(file, hashOf), {});
  addToLedger(file, [rec('app/src/Tile.jsx:3:5', 'http://x/#/e')], hashOf);
  assert.deepEqual(readLedger(file, hashOf)['app/src/Tile.jsx:3:5']!.map(r => r.url), ['http://x/#/e']);
});
