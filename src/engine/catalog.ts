import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { APP_DIR } from './paths.js';

export interface MetricDef {
  id: string;
  family: string;
  question: string;
  scope: string[];
  direction: 'up' | 'down';
  thresholds?: { watch: number; act: number; close?: number | undefined } | undefined;
  tier: string;
  phase1?: boolean | undefined;
  [k: string]: unknown;
}

export interface Settings {
  misuse_cluster_threshold: number;
  misuse_cluster_overrides: Record<string, number>;
  weekly_queue_budget: number;
  sample_floor_instances: number;
  new_code_days: number;
  severity_weights: Record<string, number>;
  [k: string]: unknown;
}

export interface Catalog {
  metrics: MetricDef[];
  settings: Settings;
  byId: Map<string, MetricDef>;
}

export function loadCatalog(file = path.join(APP_DIR, 'data', 'metric-catalog.yaml')): Catalog {
  const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  const metrics: MetricDef[] = doc.metrics ?? [];
  return { metrics, settings: doc.settings as Settings, byId: new Map(metrics.map(m => [m.id, m])) };
}

/** Grade a value against a metric's thresholds. Returns null when within bounds. */
export function grade(m: MetricDef, value: number): 'act' | 'watch' | null {
  const t = m.thresholds;
  if (!t) return null;
  if (m.direction === 'down') {
    if (value >= t.act) return 'act';
    if (value >= t.watch) return 'watch';
    return null;
  }
  if (value <= t.act) return 'act';
  if (value <= t.watch) return 'watch';
  return null;
}

/**
 * Hysteresis: an OPEN finding closes only when the value is past `close`
 * (defaults to `watch`). A gap between watch and close stops a metric that
 * hovers at the line from flapping open and shut.
 */
export function recovered(m: MetricDef, value: number): boolean {
  const t = m.thresholds;
  if (!t) return true;
  const c = t.close ?? t.watch;
  return m.direction === 'down' ? value < c : value > c;
}

/** The catalog with a profile's own metrics added (an id the catalog already has is replaced). */
export function withMetrics(catalog: Catalog, extra: Record<string, unknown>[] = []): Catalog {
  if (!extra.length) return catalog;
  const add = extra as MetricDef[];
  const ids = new Set(add.map(m => m.id));
  const metrics = [...catalog.metrics.filter(m => !ids.has(m.id)), ...add];
  return { ...catalog, metrics, byId: new Map(metrics.map(m => [m.id, m])) };
}
