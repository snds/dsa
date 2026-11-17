import fs from 'node:fs';
import path from 'node:path';

import { agentDir } from './snapshot.js';

/**
 * Dismissing an issue with a reason (redesign stage 7). The agent proposes it; a person accepts it.
 * The record moves the issue to Done on the next refresh and keeps the label, so dismissals teach:
 * "the scanner read this wrong" is the cue for a scanner hint, so the next scan doesn't raise it again.
 */
export const DISMISS_LABELS = {
  'scanner-misread': 'The scanner read this wrong',
  intended: 'It is meant to be this way',
  'not-worth-it': 'Not worth fixing',
  duplicate: 'Another issue covers it',
} as const;
export type DismissLabel = keyof typeof DISMISS_LABELS;
export interface Dismissal { label: DismissLabel; reason: string; who?: string; date: string; proposal?: string; title?: string }

const file = (dataDir: string) => path.join(agentDir(dataDir), 'dismissals.json');

export function readDismissals(dataDir: string): Record<string, Dismissal> {
  try { return JSON.parse(fs.readFileSync(file(dataDir), 'utf8')).issues ?? {}; } catch { return {}; }
}

export function addDismissal(dataDir: string, key: string, d: Dismissal) {
  const all = readDismissals(dataDir);
  all[key] = d;
  fs.mkdirSync(agentDir(dataDir), { recursive: true });
  fs.writeFileSync(file(dataDir), JSON.stringify({ $comment: 'Issues people dismissed, with the reason. The dashboard shows them under Done.', issues: all }, null, 2) + '\n');
}

export function undoDismissal(dataDir: string, key: string): boolean {
  const all = readDismissals(dataDir);
  if (!all[key]) return false;
  delete all[key];
  fs.writeFileSync(file(dataDir), JSON.stringify({ issues: all }, null, 2) + '\n');
  return true;
}
