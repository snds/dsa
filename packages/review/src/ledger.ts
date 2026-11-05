import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The evidence ledger, kept between runs: what the ledger runtime (@snds/dsa/tag LEDGER_RUNTIME) saw each
 * tagged element render with. Anything that runs the app with the runtime fills it: the crawler, a test, a
 * person clicking through a dev server started with DSA_LEDGER set. A record holds the URL it rendered on,
 * the state of each component above it and its owner's props, so the crawler can go back there and a
 * drawing can use the props the app really passed.
 *
 * Stored by file, beside the hash of that file's source when it was recorded: a record from an older
 * version of its file is dropped, since its lines and state may have moved.
 */
export interface Copied { value: unknown; cut: boolean }
export interface LedgerRec {
  /** The source tag: "file:line:col", as the tagger names the file. */
  src: string;
  url: string;
  at: number;
  w: number;
  h: number;
  owner: { name: string; props: unknown; cut: boolean } | null;
  /** The components above it, outermost first, with their state hooks' values in React's order. */
  ancestors: { name: string; hooks: Copied[] }[];
}
interface Stored { files: Record<string, { hash: string; recs: Record<string, LedgerRec[]> }> }

/** Up to this many records per element, each from a different URL. */
const PER_ELEMENT = 3;

const fileOfSrc = (src: string) => src.replace(/:\d+:\d*$/, '');

/** A file's content hash, by the path the tagger names it with; null when it can't be read. */
export type HashOf = (tagFile: string) => string | null;
export const contentHash = (abs: string): string | null => { try { return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 16); } catch { return null; } };

/** The records still current: each element's, from files whose source hasn't changed since. */
export function readLedger(file: string, hashOf: HashOf): Record<string, LedgerRec[]> {
  let stored: Stored;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  const out: Record<string, LedgerRec[]> = {};
  for (const [f, v] of Object.entries(stored.files ?? {})) {
    if (!v || hashOf(f) !== v.hash) continue;
    Object.assign(out, v.recs);
  }
  return out;
}

/**
 * New records added to the ledger file: per element, up to three, one per URL, ones that had a size on
 * the page before ones that didn't. Files whose source changed start over. Returns how many were kept.
 */
export function addToLedger(file: string, recs: LedgerRec[], hashOf: HashOf): number {
  let stored: Stored = { files: {} };
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* a new ledger */ }
  stored.files ??= {};
  let kept = 0;
  for (const r of recs) {
    if (!r || typeof r.src !== 'string') continue;
    const f = fileOfSrc(r.src);
    const hash = hashOf(f);
    if (!hash) continue;
    let at = stored.files[f];
    if (!at || at.hash !== hash) at = stored.files[f] = { hash, recs: {} };
    const list = at.recs[r.src] ?? (at.recs[r.src] = []);
    if (list.some(x => x.url === r.url)) continue;
    list.push(r);
    list.sort((a, b) => Number(b.w > 0 && b.h > 0) - Number(a.w > 0 && a.h > 0));
    if (list.length > PER_ELEMENT) list.length = PER_ELEMENT;
    kept++;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stored));
  return kept;
}

/** Records written by a dev server (DSA_LEDGER, one JSON per line). */
export function readLedgerLines(file: string): LedgerRec[] {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: LedgerRec[] = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* a torn line */ } }
  return out;
}

/** The records for an element: its own tag's, else another node's on the same line. */
export function recordsFor(ledger: Record<string, LedgerRec[]>, src: string): LedgerRec[] {
  if (ledger[src]) return ledger[src]!;
  const line = src.slice(0, src.lastIndexOf(':') + 1);
  for (const [k, v] of Object.entries(ledger)) if (k.startsWith(line)) return v;
  return [];
}
