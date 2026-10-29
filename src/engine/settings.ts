import fs from 'node:fs';
import path from 'node:path';
import type { Catalog, Settings } from './catalog.js';
import type { Config } from './config.js';
import type { Store } from './store.js';

/**
 * Effective settings = catalog defaults <- dsa.config.json "settings" <- <data>/settings.json.
 * The last layer is what "dsa settings set" writes; every change is logged with a timestamp,
 * and findings record the settings in force when they were raised.
 */
export function effectiveSettings(catalog: Catalog, config: Config, dataDir: string): Settings {
  const runtime = readRuntime(dataDir);
  return { ...catalog.settings, ...(config.settings ?? {}), ...runtime } as Settings;
}

function runtimeFile(dataDir: string) {
  return path.join(dataDir, 'settings.json');
}

function readRuntime(dataDir: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(runtimeFile(dataDir), 'utf8')); } catch { return {}; }
}

/** Parse "3", "true", '{"DataTable":4}' into JSON values; fall back to the raw string. */
export function parseValue(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

export async function setSetting(store: Store, catalog: Catalog, config: Config, dataDir: string, key: string, value: unknown, note = ''): Promise<{ old: unknown; value: unknown }> {
  if (!(key in catalog.settings)) {
    throw new Error(`Unknown setting "${key}". Known: ${Object.keys(catalog.settings).join(', ')}`);
  }
  const before = effectiveSettings(catalog, config, dataDir);
  const old = before[key];
  const expected = typeof catalog.settings[key];
  if (expected !== typeof value) throw new Error(`"${key}" expects a ${expected}, got ${typeof value}.`);
  fs.mkdirSync(dataDir, { recursive: true });
  const runtime = readRuntime(dataDir);
  runtime[key] = value;
  fs.writeFileSync(runtimeFile(dataDir), JSON.stringify(runtime, null, 2) + '\n');
  await store.insertMany('settings_log', ['ts', 'key', 'old_value', 'new_value', 'note'], [[new Date().toISOString(), key, JSON.stringify(old ?? null), JSON.stringify(value), note]]);
  return { old, value };
}

/** Misuse-cluster threshold for one asset: per-asset override, else the global default. */
export function clusterThreshold(s: Settings, component: string): number {
  return s.misuse_cluster_overrides?.[component] ?? s.misuse_cluster_threshold;
}
