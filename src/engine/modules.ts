import fs from 'node:fs';
import path from 'node:path';

/**
 * Module resolution for local shims. Many apps import DS components through a local layer
 * (`src/components/ui/button.tsx` -> `export * from "@acme/ui/button"`). To count those uses
 * as DS instances we resolve relative and alias specifiers to files, then look the file up
 * in a map of what it re-exports.
 */

const EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue'];

/** Read tsconfig/jsconfig "paths" (JSONC tolerated) into prefix -> absolute dir pairs. */
export function readAliases(dir: string, extra: Record<string, string> = {}): [string, string][] {
  const out: [string, string][] = [];
  for (const name of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    try {
      const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
      const j = JSON.parse(text);
      const base = path.resolve(dir, j.compilerOptions?.baseUrl ?? '.');
      for (const [k, v] of Object.entries<string[]>(j.compilerOptions?.paths ?? {})) {
        if (!v?.length) continue;
        out.push([k.replace(/\*$/, ''), path.resolve(base, v[0]!.replace(/\*$/, ''))]);
      }
    } catch { /* unreadable tsconfig: skip */ }
  }
  for (const [k, v] of Object.entries(extra)) out.push([k, path.resolve(dir, v)]);
  return out.sort((a, b) => b[0].length - a[0].length);
}

export function resolveSpecifier(fromFile: string, spec: string, aliases: [string, string][]): string | null {
  let base: string | null = null;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else for (const [prefix, dir] of aliases) if (prefix && spec.startsWith(prefix)) { base = path.join(dir, spec.slice(prefix.length)); break; }
  if (!base) return null;
  const candidates = [base, ...EXTS.map(e => base + e), ...EXTS.map(e => path.join(base!, 'index' + e))];
  // "./button.js" in TS source usually means button.ts(x).
  if (/\.(m?js|jsx)$/.test(base)) candidates.push(...['.ts', '.tsx'].map(e => base!.replace(/\.(m?js|jsx)$/, e)));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

export interface ShimExports {
  /** DS packages this module re-exports wholesale (export * from). */
  wildcard: string[];
  /** Exported name -> DS package + component name. `wrapper` = a local component that renders it. */
  named: Map<string, { pkg: string; imported: string; wrapper: boolean }>;
}
