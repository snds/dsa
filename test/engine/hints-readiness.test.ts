import { test } from 'vitest';
import './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyHints, hintProblems, type Hint } from '../../src/engine/hints.js';
import { readinessMetrics, tierRank, type Readiness } from '../../src/engine/readiness.js';

// Scanner hints (reviewed corrections that can't rewrite everything) and the readiness bookkeeping.
// The agent workbench itself (proposals, providers, briefs, MCP) is the agent add-on's, in Phase 3.


const evalOf = (o: any = {}) => ({
  id: 'E-1', target: 'app', file: 'app/src/Nav.tsx', line: 3, col: 1, element: 'button', role: 'toggle-group', ruleId: 'button.segmented', verdict: 'replace', use: 'ToggleGroup', props: {},
  confidence: 0.93, needsHuman: false, reasons: [], alternatives: [{ verdict: 'replace', role: 'nav-item', use: 'SidebarMenuButton', confidence: 0.7 }], visualDiffs: [], a11y: [],
  fingerprint: 'x', snippet: '', source: '<button>Colours</button>', regions: ['sidebar', 'nav'], classTokens: ['px-2', 'rounded'], match: { tag: 'button', classes: [], text: 'Colours' }, ...o,
});

test('hints: a narrow `avoid` moves a sidebar row off ToggleGroup and sends it to a human', () => {
  const e: any = evalOf();
  const h: Hint = { id: 'H-1', when: { element: 'button', region: 'sidebar', use: 'ToggleGroup' }, avoid: ['ToggleGroup'], why: 'Sidebar rows are navigation.', by: 'human', date: '2026-10-13' };
  assert.deepEqual(applyHints(e, 'src/Nav.tsx', [h], 0.9), ['H-1']);
  assert.equal(e.use, 'SidebarMenuButton');
  assert.ok(e.confidence < 0.9 && e.needsHuman, 'a fallback is a guess: below the threshold');
  assert.match(e.reasons.at(-1).text, /Scanner hint H-1/);
  const other: any = evalOf({ regions: ['toolbar'] });
  assert.deepEqual(applyHints(other, 'src/Nav.tsx', [h], 0.9), [], 'outside the sidebar the hint does nothing');
  assert.equal(other.use, 'ToggleGroup');
});

test('hints: `prefer` replaces the pick, keeps the old one as an alternative, and sets the confidence', () => {
  const e: any = evalOf();
  applyHints(e, 'src/Nav.tsx', [{ id: 'H-2', when: { element: 'button', text: '^colou?rs$' }, prefer: { verdict: 'replace', role: 'nav-item', use: 'SidebarMenuButton', props: { size: 'sm' } }, confidence: 0.95, why: 'Nav label.', by: 'human', date: 'd' }], 0.9);
  assert.equal(e.use, 'SidebarMenuButton');
  assert.equal(e.confidence, 0.95);
  assert.equal(e.alternatives[0].use, 'ToggleGroup');
});

test('hints: too broad or empty hints are refused', () => {
  assert.ok(hintProblems({ when: { element: 'button' }, avoid: ['ToggleGroup'], why: 'x' }).some(p => /at least one condition/.test(p)));
  assert.ok(hintProblems({ when: { element: 'button', region: 'sidebar' }, why: 'x' }).some(p => /prefer.*avoid/.test(p)));
  assert.ok(hintProblems({ when: { element: 'button', text: '(' }, avoid: ['X'], why: 'x' }).some(p => /regular expression/.test(p)));
  assert.deepEqual(hintProblems({ when: { element: 'button', region: 'sidebar' }, avoid: ['ToggleGroup'], why: 'Sidebar rows navigate.' }), []);
});

test('readiness: best tier and the kit persist, so a drop stays a finding until it recovers', () => {
  const r = (score: number, tier: string, kit: boolean): Readiness => ({ subject: 'app', dir: '/x', mode: 'host', score, tier, kit, checks: [] });
  const first = readinessMetrics([r(75, 'AI-native', true)], new Map())[0]!;
  assert.equal((first.detail as any).bestTier, 'AI-native');
  const second = readinessMetrics([r(55, 'Invested', false)], new Map([['app', first.detail]]))[0]!;
  assert.equal((second.detail as any).bestTier, 'AI-native');
  assert.equal((second.detail as any).hadKit, true);
  assert.ok(tierRank('Invested') < tierRank('AI-native'));
});
