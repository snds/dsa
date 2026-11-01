import fs from "node:fs";
import path from "node:path";

/**
 * How long scans take, so a page can say "about 4 minutes left". Each finished scan (dsa run, or a
 * scan dsa serve started) adds its wall time to <data>/scan-times.json; the estimate is the median
 * of the last ten. It persists with the rest of the data folder (history.adapter).
 */
const FILE = "scan-times.json";
const KEEP = 10;

export function recordScanTime(dataDir: string, ms: number, at = new Date()): void {
  const f = path.join(dataDir, FILE);
  const prev = readTimes(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(f, JSON.stringify([...prev, { at: at.toISOString(), ms: Math.round(ms) }].slice(-KEEP), null, 1));
}

export function readTimes(dataDir: string): { at: string; ms: number }[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8"));
    return Array.isArray(j) ? j.filter((x) => x && Number.isFinite(x.ms)) : [];
  } catch {
    return [];
  }
}

/** Median seconds of the recorded scans, or null with none. */
export function scanEstimate(dataDir: string): number | null {
  const ms = readTimes(dataDir).map((t) => t.ms).sort((a, b) => a - b);
  if (!ms.length) return null;
  const mid = ms.length / 2;
  const m = ms.length % 2 ? ms[Math.floor(mid)]! : (ms[mid - 1]! + ms[mid]!) / 2;
  return Math.round(m / 1000);
}
