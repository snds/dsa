import type { Place } from './types.js';

/**
 * Evidence as data. New findings carry their places; older ones only have the text, whose
 * "Examples: a.tsx:8, b.tsx:12" tail is read back into places so the page shows them the same way.
 */

const TAIL = /\.\s*(?:Examples|Worst|Files):\s*(.*)$/s;

/** "src/a.tsx:8" or "src/a.tsx:8:3" into a place; null for anything else ("src/a.tsx (12)"). */
export function parsePlace(s: string): Place | null {
  const m = s.trim().match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (!m || /\s/.test(m[1]!)) return null;
  return { file: m[1]!, line: Number(m[2]), ...(m[3] ? { col: Number(m[3]) } : {}) };
}

/** The places an evidence text cites, for findings stored before places were. */
export function parsePlaces(evidence: string): Place[] {
  const tail = evidence.match(TAIL)?.[1];
  if (!tail) return [];
  return tail.split(/,\s*/).map(parsePlace).filter((p): p is Place => p != null);
}

/** The evidence sentence without its list of examples: the part worth reading on first view. */
export function evidenceSummary(evidence: string): string {
  return evidence.replace(TAIL, '.').replace(/\.\.$/, '.').trim();
}

/** Code that isn't the owner's to fix: vendored copies, dependencies, third-party folders. */
export function isVendored(file: string): boolean {
  return /(^|\/)(vendor|vendors|vendored|third[_-]party|node_modules|external|bower_components)\//i.test(file);
}
