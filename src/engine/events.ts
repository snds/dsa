import fs from 'node:fs';
import path from 'node:path';

/**
 * The suite's own problems, kept for Settings › Notes: a scan that failed, screenshots or rendered
 * signatures that were skipped, and why. Newest last; capped so it never grows without bound.
 */
export interface SuiteEvent { at: string; level: 'error' | 'warning' | 'info'; source: string; message: string; detail?: string | undefined }

const file = (dataDir: string) => path.join(dataDir, 'events.json');

export function readEvents(dataDir: string): SuiteEvent[] {
  try { return JSON.parse(fs.readFileSync(file(dataDir), 'utf8')); } catch { return []; }
}

export function logEvent(dataDir: string, e: Omit<SuiteEvent, 'at'>) {
  const list = [...readEvents(dataDir), { at: new Date().toISOString(), ...e }].slice(-200);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file(dataDir), JSON.stringify(list, null, 1));
}

export function clearEvents(dataDir: string) {
  try { fs.unlinkSync(file(dataDir)); } catch { /* none */ }
}
