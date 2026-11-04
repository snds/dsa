import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, Config } from './config.js';
import { resolveTargets } from './workspaces.js';

/**
 * An app's own dsa.config.json, merged into the run's config. The run calls an app by its target name (its
 * folder, or the name the host config gives it), while the app's own file, and often the host's `apps`,
 * key it by its package name: either is accepted, and the entry is filed under the target name. From the
 * app's file come its `apps` entry (routes, extraRoutes, flows and the rest; the host's own values win, lists
 * are joined) and the folders its `scan.exclude` names ("stubs/**"), skipped as the host's are. Returns the
 * merged config and the `apps` keys that name no app, for the caller to stop on.
 */
export function federate(root: string, c: Config): { config: Config; unmatched: string[]; merged: string[] } {
  let targets: ReturnType<typeof resolveTargets>;
  try { targets = resolveTargets(root, c); } catch { return { config: c, unmatched: [], merged: [] }; }
  const pkgOf = (dir: string): string | undefined => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name; } catch { return undefined; } };
  const apps: Record<string, AppSettings> = { ...(c.apps ?? {}) };
  const names = new Set(targets.map(t => t.name));
  // The host's keys by package name, filed under the target name.
  for (const t of targets) {
    const pkg = pkgOf(t.dir);
    if (pkg && pkg !== t.name && apps[pkg] && !names.has(pkg)) { apps[t.name] = joinApp(apps[t.name], apps[pkg]!); delete apps[pkg]; }
  }
  const exclude = [...(c.exclude ?? [])];
  const merged: string[] = [];
  for (const t of targets) {
    if (t.role === 'core' || path.resolve(t.dir) === path.resolve(root)) continue;
    let own: any;
    try { own = JSON.parse(fs.readFileSync(path.join(t.dir, 'dsa.config.json'), 'utf8')); } catch { continue; }
    if (!own || typeof own !== 'object') continue;
    const pkg = pkgOf(t.dir);
    const keys = Object.keys(own.apps ?? {});
    // Its own entry: by target name, by package name, or the only one it has.
    const entry = own.apps?.[t.name] ?? (pkg ? own.apps?.[pkg] : undefined) ?? (keys.length === 1 ? own.apps[keys[0]!] : undefined);
    if (entry && typeof entry === 'object') { apps[t.name] = joinApp(apps[t.name], entry); merged.push(t.name); }
    for (const e of (own.scan?.exclude ?? []) as string[]) {
      const folder = typeof e === 'string' ? e.replace(/\/\*\*$/, '') : '';
      if (!folder || /[*?[\]{}]/.test(folder)) continue;
      const rel = path.relative(root, path.resolve(t.dir, folder)).split(path.sep).join('/');
      if (!exclude.includes(rel)) exclude.push(rel);
    }
  }
  const unmatched = Object.keys(apps).filter(k => !names.has(k));
  const config: Config = { ...c, ...(Object.keys(apps).length ? { apps } : {}), ...(exclude.length ? { exclude } : {}) };
  return { config, unmatched, merged };
}

/** Two `apps` entries as one: `host`'s values win; route and flow lists are joined, each once. */
function joinApp(host: AppSettings | undefined, own: AppSettings): AppSettings {
  const out: Record<string, unknown> = { ...own, ...(host ?? {}) };
  for (const k of ['extraRoutes', 'flows'] as const) {
    const all = [...((own[k] as unknown[] | undefined) ?? []), ...((host?.[k] as unknown[] | undefined) ?? [])];
    const seen = new Set<string>();
    const list = all.filter(x => { const j = JSON.stringify(x); if (seen.has(j)) return false; seen.add(j); return true; });
    if (list.length) out[k] = list;
  }
  return out as AppSettings;
}
