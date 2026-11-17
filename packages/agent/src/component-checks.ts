import fs from 'node:fs';
import path from 'node:path';

import { agentDir } from './snapshot.js';

/**
 * A person's answer to "needs a check" on a component (redesign stage 8): Confirm (the scan is right,
 * it is a system component) or Correct (with a note saying what it really is). Keyed by component
 * name. The dashboard reads it to drop the component from "Needs a check" and close its Confirm issue.
 */
export interface ComponentCheck { verdict: 'confirmed' | 'corrected'; note?: string; who?: string; date: string }

const file = (dataDir: string) => path.join(agentDir(dataDir), 'component-checks.json');

export function readComponentChecks(dataDir: string): Record<string, ComponentCheck> {
  try { return JSON.parse(fs.readFileSync(file(dataDir), 'utf8')).components ?? {}; } catch { return {}; }
}

export function setComponentCheck(dataDir: string, name: string, c: ComponentCheck | null) {
  const all = readComponentChecks(dataDir);
  if (c) all[name] = c; else delete all[name];
  fs.mkdirSync(agentDir(dataDir), { recursive: true });
  fs.writeFileSync(file(dataDir), JSON.stringify({ $comment: 'Components a person confirmed or corrected from "Needs a check".', components: all }, null, 2) + '\n');
}
