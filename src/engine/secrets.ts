import fs from 'node:fs';
import path from 'node:path';

/**
 * Tokens live in <data>/secrets.json (owner read/write only, inside the gitignored data folder),
 * never in dsa.config.json, so the config can be committed safely.
 * Environment variables win: FIGMA_TOKEN, GITHUB_TOKEN / GH_TOKEN.
 */
export interface Secrets { figmaToken?: string | undefined; githubToken?: string | undefined }

const file = (dataDir: string) => path.join(dataDir, 'secrets.json');

export function readSecrets(dataDir: string): Secrets {
  try { return JSON.parse(fs.readFileSync(file(dataDir), 'utf8')); } catch { return {}; }
}

export function writeSecrets(dataDir: string, patch: Partial<Record<keyof Secrets, string | null>>): void {
  const cur = readSecrets(dataDir);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || v === '') delete (cur as any)[k];
    else (cur as any)[k] = v.trim();
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file(dataDir), JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file(dataDir), 0o600); } catch { /* non-POSIX */ }
}

export function figmaToken(dataDir: string): string | undefined {
  return process.env.FIGMA_TOKEN || readSecrets(dataDir).figmaToken || undefined;
}

export function githubToken(dataDir: string): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || readSecrets(dataDir).githubToken || undefined;
}

/** "figd_abcd…wxyz" -> "figd…wxyz": enough to recognize, not enough to use. */
export function mask(token?: string): string | null {
  if (!token) return null;
  return token.length <= 8 ? '••••' : `${token.slice(0, 4)}…${token.slice(-4)}`;
}
