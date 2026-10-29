import type { Config } from './config.js';
import type { FigmaUsageRow, Instance, Lookalike, Target, TokenRow, VersionRow } from './types.js';

/** Everything one scan produced. Metrics and rules are pure functions over this. */
export interface ScanData {
  targets: Target[];
  versions: VersionRow[];
  instances: Instance[];
  lookalikes: Lookalike[];
  tokens: TokenRow[];
  figma: FigmaUsageRow[];
  figmaCrawled: boolean;
  /** Element review: one evaluation per native element the map covers. */
  elementEvals?: import('./elements.js').ElementEval[] | undefined;
}

export interface MetricRow {
  metric_id: string;
  scope: string;
  subject: string;
  value: number;
  detail: Record<string, unknown>;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const groupBy = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); }
  return m;
};

export function computeMetrics(data: ScanData, config: Config): MetricRow[] {
  const out: MetricRow[] = [];
  const roleOf = new Map(data.targets.map(t => [t.name, t.role]));

  // version_currency: worst lag across a target's DS packages.
  for (const [target, rows] of groupBy(data.versions, v => v.target)) {
    const known = rows.filter(r => r.majorsBehind !== null);
    if (!known.length) continue;
    const worst = known.reduce((a, b) => ((b.majorsBehind ?? 0) > (a.majorsBehind ?? 0) ? b : a));
    out.push({ metric_id: 'version_currency', scope: roleOf.get(target) ?? 'consumer', subject: target, value: worst.majorsBehind ?? 0,
      detail: { packages: rows.map(r => ({ pkg: r.pkg, library: r.library, declared: r.declared, resolved: r.resolved, latest: r.latest, majorsBehind: r.majorsBehind })) } });
  }

  // pin_currency_days: SHA-pinned consumption, days the pin trails core's main.
  for (const r of data.versions.filter(v => v.daysBehind != null)) {
    out.push({ metric_id: 'pin_currency_days', scope: roleOf.get(r.target) ?? 'consumer', subject: r.target, value: r.daysBehind!,
      detail: { pinFile: r.pkg.replace(/^pin:/, ''), pinned: r.resolved, latest: r.latest, commitsBehind: r.commitsBehind } });
  }

  // correct_use_rate: per target, and per target x component (rules use the latter).
  for (const [target, rows] of groupBy(data.instances, i => i.target)) {
    const overridden = rows.filter(r => r.overrides.length).length;
    out.push({ metric_id: 'correct_use_rate', scope: roleOf.get(target) ?? 'consumer', subject: target, value: pct(rows.length - overridden, rows.length), detail: { instances: rows.length, overridden } });
    for (const [component, crow] of groupBy(rows, r => r.component)) {
      const ov = crow.filter(r => r.overrides.length);
      const kinds: Record<string, number> = {};
      for (const r of ov) for (const k of r.overrides) kinds[k] = (kinds[k] ?? 0) + 1;
      out.push({ metric_id: 'correct_use_rate', scope: 'component', subject: `${target}|${component}`, value: pct(crow.length - ov.length, crow.length),
        detail: { target, component, library: crow[0]!.library, instances: crow.length, overridden: ov.length, kinds, examples: ov.slice(0, 5).map(r => `${r.file}:${r.line}`) } });
    }
  }

  // custom_ratio: raw look-alikes vs real instances, per target x imitated component.
  const instCount = new Map<string, number>();
  for (const i of data.instances) instCount.set(`${i.target}|${i.component}`, (instCount.get(`${i.target}|${i.component}`) ?? 0) + 1);
  for (const [key, rows] of groupBy(data.lookalikes, l => `${l.target}|${l.component}`)) {
    const [target, component] = key.split('|');
    const real = instCount.get(key) ?? 0;
    out.push({ metric_id: 'custom_ratio', scope: 'component', subject: key, value: pct(rows.length, rows.length + real),
      detail: { target, component, lookalikes: rows.length, instances: real, elements: [...new Set(rows.map(r => r.element))], examples: rows.slice(0, 5).map(r => `${r.file}:${r.line}`) } });
  }

  // token_compliance_new_code: token refs share of style values in recently changed files.
  for (const [target, rows] of groupBy(data.tokens, t => t.target)) {
    const fresh = rows.filter(r => r.isNew);
    const raw = fresh.reduce((a, r) => a + r.rawValues, 0);
    const refs = fresh.reduce((a, r) => a + r.tokenRefs, 0);
    if (raw + refs === 0) continue;
    const worst = [...fresh].sort((a, b) => b.rawValues - a.rawValues).slice(0, 5).filter(r => r.rawValues);
    out.push({ metric_id: 'token_compliance_new_code', scope: roleOf.get(target) ?? 'consumer', subject: target, value: pct(refs, raw + refs),
      detail: { rawValues: raw, tokenRefs: refs, newFiles: fresh.length, worstFiles: worst.map(r => `${r.file} (${r.rawValues})`) } });
  }

  // deprecation_burndown: remaining usages of deprecated components per target.
  const deprecated = config.deprecated ?? {};
  for (const [target, rows] of groupBy(data.instances.filter(i => i.component in deprecated), i => i.target)) {
    const byComp: Record<string, number> = {};
    for (const r of rows) byComp[r.component] = (byComp[r.component] ?? 0) + 1;
    out.push({ metric_id: 'deprecation_burndown', scope: roleOf.get(target) ?? 'consumer', subject: target, value: rows.length,
      detail: { byComponent: byComp, replacements: Object.fromEntries(Object.keys(byComp).map(c => [c, deprecated[c]])), examples: rows.slice(0, 5).map(r => `${r.file}:${r.line}`) } });
  }

  // Figma: instance adoption and the look-alike frame proxy for detaches, per library component.
  if (data.figmaCrawled) {
    for (const [key, rows] of groupBy(data.figma, r => `${r.library}|${r.component}`)) {
      const inst = rows.reduce((a, r) => a + r.instances, 0);
      const frames = rows.reduce((a, r) => a + r.lookalikeFrames, 0);
      const [library, component] = key.split('|');
      out.push({ metric_id: 'figma_instance_adoption', scope: 'component', subject: key, value: inst, detail: { library, component, files: rows.filter(r => r.instances).length } });
      if (inst + frames > 0) {
        out.push({ metric_id: 'figma_detach_rate', scope: 'component', subject: key, value: pct(frames, inst + frames),
          detail: { library, component, instances: inst, lookalikeFrames: frames, files: rows.filter(r => r.lookalikeFrames).map(r => r.fileName) } });
      }
    }
  }
  return out;
}
