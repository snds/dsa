import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeFit } from './fit.js';
import { questions } from './questions.js';
import { proposalKey } from './rendered.js';
import type { ElementEval } from './elements.js';

/**
 * What a review card proposes, so the render pass draws the same thing. A card takes the evaluator's
 * recommendation, except its size: the closest measured size when the evaluator named none (or one that
 * measures clearly worse). "Approve" means that size, so `dsa render` has to draw that size too.
 */
export function autoPick(dataDir: string, items: ElementEval[], rec: any): { auto: any; fit: any } {
  let fit: any = null;
  if (rec?.verdict === 'replace' && rec.use) {
    const f = computeFit(dataDir, items, rec.use, rec.props ?? {});
    const sz = f?.axes?.size;
    if (sz && f!.best.size) fit = { best: f!.best.size, score: sz[f!.best.size]!.score, recSize: rec.props?.size ?? defaultSize(dataDir, rec.use), source: sz[f!.best.size]!.source };
  }
  let auto = rec;
  if (fit && rec && fit.best !== fit.recSize && fit.source !== 'static') {
    const recScore = computeFit(dataDir, items, rec.use!, rec.props ?? {})?.axes?.size?.[fit.recSize]?.score ?? 0;
    if (!rec.props?.size || fit.score - recScore >= 0.03) auto = { ...rec, props: { ...(rec.props ?? {}), size: fit.best } };
  }
  return { auto, fit };
}

const sigCache = new Map<string, any[]>();
function defaultSize(dataDir: string, component: string): string {
  if (!sigCache.has(dataDir)) { try { sigCache.set(dataDir, JSON.parse(fs.readFileSync(path.join(dataDir, 'signatures.json'), 'utf8'))); } catch { sigCache.set(dataDir, []); } }
  return sigCache.get(dataDir)!.find((x) => x.component === component)?.defaults?.size ?? 'default';
}

/** The cards' own picks: each question's and each part's auto-pick, by the ids it covers. */
export function cardPicks(dataDir: string, evals: ElementEval[], threshold?: number): { ids: string[]; auto: any }[] {
  sigCache.delete(dataDir);
  const out: { ids: string[]; auto: any }[] = [];
  for (const q of questions(evals, { answered: true, threshold })) {
    out.push({ ids: q.items.map((i) => i.id), auto: autoPick(dataDir, q.items, q.options[0]?.decision).auto });
    for (const p of q.parts ?? []) out.push({ ids: p.items.map((i) => i.id), auto: autoPick(dataDir, p.items, p.options[0]?.decision).auto });
  }
  return out;
}

/**
 * An element's own content, to render its proposal with: its words, its accessible name, and its icon
 * (markup taken from the page when it was photographed). Missing pieces stay missing; nothing is invented.
 */
export interface OwnContent {
  text?: string | undefined; ariaLabel?: string | undefined; icon?: string | undefined;
  /** No icon captured from a page: the icon component its JSX holds (`<PlusIcon />`), to draw that one. */
  iconName?: string | undefined;
}

/** A short hash of an element's own content; null when it has none to give. */
export function contentHash(own: OwnContent | null | undefined): string | null {
  if (!own || (!own.text && !own.ariaLabel && !own.icon && !own.iconName)) return null;
  // An icon named in the source (no markup) hashes as its name, so content without one hashes as before.
  return crypto.createHash('sha1').update(JSON.stringify([own.text ?? '', own.ariaLabel ?? '', own.icon ?? (own.iconName ? `name:${own.iconName}` : '')])).digest('hex').slice(0, 10);
}

/** The key a proposal drawn with an element's own content is stored under: the proposal's key, then the content's hash. */
export function ownKey(use: string, props: Record<string, unknown> | null | undefined, own: OwnContent | null | undefined): string {
  const h = contentHash(own);
  return h ? `${proposalKey(use, props)}#${h}` : proposalKey(use, props);
}

/**
 * An element's own content: what its photo recorded from the page, else what the source says (its text,
 * its aria-label, and the icon component inside it). A drawing from the code (drawn.ts) records content too.
 */
export function ownOf(e: Pick<ElementEval, 'match'> & { source?: string | undefined; snippet?: string | undefined }, shot?: { content?: OwnContent | null } | null): OwnContent | null {
  const c = shot?.content ?? null;
  const icon = c?.icon || undefined;
  const own: OwnContent = { text: c?.text || e.match?.text || undefined, ariaLabel: c?.ariaLabel || e.match?.ariaLabel || undefined, icon, iconName: icon ? undefined : iconInSource(e) };
  if (!own.iconName) delete own.iconName;
  return own.text || own.ariaLabel || own.icon || own.iconName ? own : null;
}

/** The icon component an element's JSX holds: the first self-closing component inside it (`<PlusIcon className="size-4" />`). */
export function iconInSource(e: { source?: string | undefined; snippet?: string | undefined }): string | undefined {
  const src = e.source ?? '';
  const inner = e.snippet && src.startsWith(e.snippet) ? src.slice(e.snippet.length) : '';
  const m = inner.match(/<([A-Z][\w]*(?:\.[A-Z][\w]*)?)\b[^<>]*?\/>/);
  return m?.[1];
}
