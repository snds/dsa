import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { defineAddon, STORE_MIGRATIONS, STORE_SCHEMA, type Store } from "@snds/dsa";

/** One local DuckDB file (<data>/dsa.duckdb) holds every run. */
class DuckStore implements Store {
  private constructor(
    private conn: DuckDBConnection,
    readonly file: string,
    private db: DuckDBInstance,
  ) {}

  static async open(dataDir: string): Promise<DuckStore> {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "dsa.duckdb");
    const db = await DuckDBInstance.create(file);
    const conn = await db.connect();
    for (const stmt of STORE_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await conn.run(stmt);
    for (const m of STORE_MIGRATIONS) await conn.run(m);
    return new DuckStore(conn, file, db);
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.conn.run(sql, params as never);
  }

  async all<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.conn.runAndReadAll(sql, params as never);
    return r.getRowObjectsJson() as unknown as T[];
  }

  async insertMany(table: string, cols: string[], rows: unknown[][]): Promise<void> {
    if (!rows.length) return;
    const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `insert into ${table} (${cols.join(", ")}) values (${ph})`;
    await this.conn.run("begin transaction");
    try {
      for (const r of rows) await this.conn.run(sql, r.map((v) => (v === undefined ? null : v)) as never);
      await this.conn.run("commit");
    } catch (e) {
      await this.conn.run("rollback");
      throw e;
    }
  }

  async latestRunId(): Promise<string | null> {
    const r = await this.all<{ run_id: string }>("select run_id from runs order by taken_at desc limit 1");
    return r[0]?.run_id ?? null;
  }

  /** Close the connection and the instance now; leaving the instance to GC finalizers can crash the native module. */
  close(): void {
    this.conn.closeSync();
    this.db.closeSync();
  }
}

/** Open (and create, the first time) the DuckDB store in a data folder. */
export const openDuckStore = (dataDir: string): Promise<Store> => DuckStore.open(dataDir);

export default defineAddon({
  name: "@snds/dsa-history",
  store: openDuckStore,
});
