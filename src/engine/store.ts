/**
 * The run history: every run's raw rows, metrics, findings and their event log, so trends are just
 * queries. The core defines the tables and this interface; the history add-on (@snds/dsa-history)
 * supplies a DuckDB-backed store. SQL is DuckDB's dialect ($1 parameters, json columns).
 */
export interface Store {
  /** Where the data lives (a file path), for messages. */
  readonly file: string;
  exec(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Insert many rows in one transaction. Values are passed as parameters, never interpolated. */
  insertMany(table: string, cols: string[], rows: unknown[][]): Promise<void>;
  latestRunId(): Promise<string | null>;
  close(): void;
}

/** Opens (and creates, the first time) the store in a data folder. */
export type StoreFactory = (dataDir: string) => Promise<Store>;

/** Raw scan rows are kept per run (small: thousands of rows, not billions); findings are one upserted table plus an append-only event log. */
export const STORE_SCHEMA = `
create table if not exists runs (run_id varchar primary key, taken_at timestamp, host_root varchar, settings json, sources json);
create table if not exists versions (run_id varchar, target varchar, role varchar, pkg varchar, library varchar, declared varchar, resolved varchar, latest varchar, majors_behind integer);
create table if not exists instances (run_id varchar, target varchar, library varchar, pkg varchar, component varchar, file varchar, line integer, framework varchar, overrides varchar);
create table if not exists lookalikes (run_id varchar, target varchar, element varchar, component varchar, file varchar, line integer);
create table if not exists tokens (run_id varchar, target varchar, file varchar, raw_values integer, token_refs integer, is_new boolean);
create table if not exists figma_usage (run_id varchar, file_key varchar, file_name varchar, project varchar, library varchar, component varchar, instances integer, lookalike_frames integer);
create table if not exists metrics (run_id varchar, metric_id varchar, scope varchar, subject varchar, value double, detail json);
create table if not exists findings (id varchar primary key, rule varchar, subject varchar, scope varchar, owner varchar, repo varchar, family varchar, severity varchar, score double, title varchar, why varchar, evidence varchar, fix varchar, exit varchar, affected json, settings_used json, status varchar, opened_at timestamp, updated_at timestamp, resolved_at timestamp, snooze_until timestamp, snooze_reason varchar, metric_value double, issue_url varchar);
create table if not exists finding_events (id varchar, run_id varchar, ts timestamp, event varchar, detail json);
create table if not exists settings_log (ts timestamp, key varchar, old_value json, new_value json, note varchar);
create table if not exists element_evals (run_id varchar, id varchar, target varchar, file varchar, line integer, element varchar, role varchar, verdict varchar, use_component varchar, confidence double, needs_human boolean, exception varchar, decided boolean, data json);
create table if not exists baselines (metric_id varchar, subject varchar, value double, set_at timestamp);
`;

/** Additive migrations for stores created by earlier versions. */
export const STORE_MIGRATIONS = [
  'alter table versions add column if not exists days_behind integer',
  'alter table versions add column if not exists commits_behind integer',
];

/** Every table, for dumps and tests. */
export const STORE_TABLES = ['runs', 'versions', 'instances', 'lookalikes', 'tokens', 'figma_usage', 'metrics', 'findings', 'finding_events', 'settings_log', 'element_evals', 'baselines'] as const;

/** Thrown when a command needs the run history and no store add-on is installed. */
export class MissingStoreError extends Error {
  constructor(command: string) {
    super(`"dsa ${command}" keeps run history, and that needs the history add-on. Install it next to dsa: npm install --save-dev @snds/dsa-history`);
    this.name = 'MissingStoreError';
  }
}

let registered: StoreFactory | null = null;

/** Set the store every command opens (the history add-on calls this when it loads). */
export function registerStore(factory: StoreFactory | null): void {
  registered = factory;
}

export function hasStore(): boolean {
  return registered !== null;
}

/** Open the registered store, or explain what to install. */
export async function openStore(dataDir: string, command = 'run'): Promise<Store> {
  if (!registered) throw new MissingStoreError(command);
  return registered(dataDir);
}
