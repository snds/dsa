import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { subjectKey } from '../src/context.js';

// From the nine-way review (code C C-03): a request's ids became a brief's file name, so one POST could
// write a .md file anywhere (an AGENTS.md included).

test('brief keys are file names: ids and names from a request can\'t climb out of the folder', () => {
  for (const s of [
    { kind: 'queue', id: '../../../../PWNED' },
    { kind: 'review', ids: ['../../AGENTS', 'E-2'] },
    { kind: 'issue', key: '../x' },
    { kind: 'readiness', subject: '/etc/passwd' },
    { kind: 'group', by: 'component', value: '..' },
  ] as any[]) {
    const k = subjectKey(s);
    assert.doesNotMatch(k, /\.\.|\/|\\/, `${JSON.stringify(s)} → ${k}`);
    assert.equal(path.basename(`${k}.md`), `${k}.md`);
  }
  assert.equal(subjectKey({ kind: 'queue', id: 'F-1A2B3C' }), 'queue-F-1A2B3C');
});
