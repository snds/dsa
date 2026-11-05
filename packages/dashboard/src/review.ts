import { canonicalProps, hashText } from '@snds/dsa';
import { CONTAINER_ROLES, NO_SOURCE, SHOT_MIN, proposalKey } from './trust.js';

/**
 * Review for people. A person (a designer first) decides from what they can see, never from code, so an
 * element is only offered for review when both halves of the comparison are real:
 *
 *   the current element  its own photo of the running app (or an isolated render: mounted in the app's
 *                        build with the props it was recorded with), painted, matched, from this run;
 *   the proposal         the system component drawn exactly, with the element's own words and content.
 *
 * Anything less (markup only, a drawing with guessed props, no photo, no exact render) is "needs evidence
 * before review", with the plain reason and what would fix it. It is never queued and never labelled.
 */
export interface Evidence {
  ready: boolean;
  /** How the current element is shown: a live photo or an isolated render. Null when it can't be. */
  current: 'live' | 'isolated' | null;
  /** What's missing, in plain words, and what would fix each. Empty when ready. */
  missing: { why: string; fix: string }[];
}

/** What the element's card proposes: a question's (or part's) pick, else its own recommendation. */
export function picksOf(payload: any): Map<string, any> {
  const E = payload.elements, out = new Map<string, any>();
  for (const q of E?.questions ?? []) {
    for (const p of q.parts ?? []) for (const id of p.ids) out.set(id, p.auto);
    for (const id of q.ids) if (!out.has(id)) out.set(id, q.auto);
  }
  return out;
}

/**
 * The proposal render for an element and a pick: with its own content first, else the plain one. A plain
 * render never counts as drawn with this element's words, whatever it was drawn with.
 */
export function proposalFor(E: any, e: any, pick: any): any | null {
  if (pick?.verdict !== 'replace' || !pick.use) return null;
  const key = proposalKey(pick.use, pick.props);
  const mine = e.ownHash ? E.proposals?.[`${key}#${e.ownHash}`] : null;
  if (mine) return mine;
  const plain = E.proposals?.[key];
  return plain ? { ...plain, own: false } : null;
}

/** The element's own words, as its photo recorded them (else its label), for comparing with a drawing's. */
const wordsOf = (e: any): string => String(e.shot?.content?.text ?? e.label ?? '').replace(/\s+/g, ' ').trim();
/** A drawing shows the element's own words: drawn with them, and the words it drew are the element's. */
export function drawnWithOwnWords(p: any, e: any): boolean {
  if (!p?.own) return false;
  if (typeof p.text !== 'string') return !wordsOf(e);
  return p.text.replace(/\s+/g, ' ').trim() === wordsOf(e);
}

/** Can a person review this element? */
export function evidenceOf(E: any, e: any, pick: any): Evidence {
  const missing: Evidence['missing'] = [];
  const s = e.shot;
  let current: Evidence['current'] = null;
  if (!s) {
    if (e.staleShot) missing.push({ why: 'Its only photo is from an older run, so it may not show the code as it is now.', fix: 'Take the screenshots again.' });
    else if (e.reach?.why) missing.push({ why: `The crawler couldn't reach it: ${String(e.reach.why).replace(/\.$/, '')}.`, fix: 'Add a route or a flow that opens it, or record it while someone uses the app.' });
    else missing.push({ why: 'There is no photo of it in the app.', fix: 'Take screenshots of the app (dsa run with screenshots on).' });
  } else if (s.blank) missing.push({ why: 'Its photo shows nothing: it may need a state the crawler could not set.', fix: 'Add a flow that puts the page in that state.' });
  else if (s.covered) missing.push({ why: 'Something else covers it in its photo.', fix: 'Take the photo again with the covering layer closed.' });
  else if (s.source === 'isolated') current = 'isolated';
  else if (s.drawn === 'markup') missing.push({ why: 'Only its markup could be drawn, not the element as the app draws it.', fix: 'Reach it in the running app, or record its props so it can be drawn as an isolated render.' });
  else if (s.drawn) missing.push({ why: 'It was drawn from the code with guessed props, so it may not look like the real thing.', fix: 'Reach it in the running app, or record its props so it can be drawn as an isolated render.' });
  else if (!s.tagged && (s.match ?? 0) < SHOT_MIN) missing.push({ why: 'Its photo may be of a different element that looks like it.', fix: 'Build the app with source tags, so the photo is found by its line.' });
  else current = 'live';
  if (pick?.verdict === 'replace' && pick.use) {
    const p = proposalFor(E, e, pick);
    const what = [pick.use, ...Object.entries(pick.props ?? {}).filter(([k]) => k !== 'render').map(([k, v]) => `${k} ${v}`)].join(', ');
    const container = CONTAINER_ROLES.has(e.role) || CONTAINER_ROLES.has(pick.role);
    if (p && p.check === 'none' && !p.url && (p.noSource || NO_SOURCE.test(p.note ?? ''))) missing.push({ why: `The system has nothing to draw ${pick.use} from.`, fix: `Add a story or source for ${pick.use}, or propose another component.` });
    else if (!p?.url) missing.push({ why: `The proposal (${what}) isn't drawn yet.`, fix: 'Draw the proposals (dsa render).' });
    else if (p.check !== 'exact') missing.push({ why: `The proposal (${what}) is only drawn as a near match, not with these props.`, fix: 'Draw the proposals (dsa render).' });
    // A stand-in icon reads as a different control; sample words as a different label: neither is decidable.
    else if (!container && /stand-in|^icon|icon .*couldn't be loaded/.test(p.content ?? '')) missing.push({ why: "The proposal is drawn with a stand-in icon, not this element's own icon, so it may read as a different control.", fix: "Take the photo again so its icon is recorded, then draw the proposal again (dsa render)." });
    else if (!container && (e.ownHash || p.content) && !drawnWithOwnWords(p, e)) missing.push({ why: p.own ? "The proposal's words aren't this element's own." : "The proposal shows the system's sample words, not this element's own.", fix: 'Draw the proposal again once its own words are known (a photo records them).' });
  }
  return { ready: !missing.length, current, missing };
}

/** A page's address in plain words: "#/requests/table/sheet/add-request" → "Requests › Table › Sheet › Add request". */
export function pageName(url: string | null | undefined): string {
  if (!url) return 'an unknown page';
  let route = url;
  try { const u = new URL(url); route = u.hash.length > 1 ? u.hash.slice(1) : u.pathname; } catch { /* a bare path */ }
  // A segment that is a framework's generated id (_r_4k_, :r1:) says nothing to a person: left out.
  const all = route.split('?')[0]!.split('/').filter(Boolean).map((x) => decodeURIComponent(x));
  const parts = all.filter((x) => !/^(_r_\w*_|:r\w*:|_+)$/.test(x));
  if (!parts.length) return all.length ? 'an unnamed page' : 'the home page';
  const word = (p: string) => (/\d/.test(p) ? p : p.replace(/[-_]+/g, ' '));
  // "colour/CB-401/from/list/colours" → "Colour CB-401, opened from the Colours list": a sentence where the
  // route says where it was opened from.
  const from = parts.findIndex((p) => p.toLowerCase() === 'from');
  if (from > 0) {
    const here = parts.slice(0, from).map(word).join(' ');
    const there = parts.slice(from + 1).map(word);
    const kind = there.find((w) => /^(list|table|board|grid|search|library)$/i.test(w));
    const rest = there.filter((w) => w !== kind).join(' ');
    const cap = (t: string) => t.replace(/^./, (c) => c.toUpperCase());
    return `${cap(here)}, opened from ${there.length ? `the ${kind ? `${cap(rest)} ${kind.toLowerCase()}` : cap(there.join(' '))}`.replace(/\s+/g, ' ') : 'another page'}`;
  }
  const words = parts.slice(-5).map((p) => (/\d/.test(p) ? p : word(p).replace(/^./, (c) => c.toUpperCase())));
  return words.join(' › ');
}

export interface ReviewQueueEntry { id: string; why: 'disagree' | 'audit'; note?: string | undefined }

/** One place the app already uses a system component, with its props and, when the crawler has one, its photo. */
export interface Precedent { app: string; file: string; line: number; component: string; props: Record<string, string>; shot?: { url: string; box: any; page?: string | undefined; pageName: string } | null }

/**
 * Add what the review needs to a report payload (in place): each element's evidence (`review`), the
 * queue of ready elements to check (from `dsa labels queue`, else a seeded 10% audit of the ready ones),
 * what is set aside for want of evidence, the system's allowed props, and precedents.
 */
export function withReview(payload: any, o: {
  queue?: ReviewQueueEntry[] | null;
  audit?: number; seed?: string;
  system?: { component: string; axes?: Record<string, string[]>; defaults?: Record<string, string> }[];
  precedents?: Precedent[];
  sourceRef?: (e: any) => string;
} = {}): any {
  const E = payload.elements;
  if (!E) return payload;
  const picks = picksOf(payload);
  const live = (E.evals ?? []).filter((e: any) => !e.exception && e.reach?.status !== 'unused' && e.verdict !== 'ignore');
  for (const e of E.evals ?? []) {
    const pick = picks.get(e.id) ?? (e.decided ? e.decided.decision : e);
    e.review = { ...evidenceOf(E, e, pick), pageName: pageName(e.shot?.page) };
  }
  const ready = live.filter((e: any) => e.review.ready);
  // The queue: what `dsa labels queue` chose (disagreements, then its audit), kept only where it can be
  // reviewed; else every ready "ready" card drawn at random, a tenth of them, the same draw each time.
  const byId = new Map<string, any>(live.map((e: any) => [e.id, e]));
  let entries: ReviewQueueEntry[];
  if (o.queue?.length) entries = o.queue.filter((q) => byId.get(q.id)?.review.ready);
  else {
    const share = o.audit ?? 0.1;
    const draw = (id: string) => parseInt(hashText(`${o.seed ?? 'dsa'}\u0001${id}`).slice(0, 8), 16) / 0xffffffff;
    entries = ready.filter((e: any) => !e.decided && !e.needsHuman && draw(e.id) < share).map((e: any) => ({ id: e.id, why: 'audit' as const }));
  }
  const defaults = new Map((o.system ?? []).map((c) => [c.component, c.defaults ?? {}]));
  const key = (use: string, props: Record<string, unknown> | undefined) => `${use}|${JSON.stringify(canonicalProps(props, defaults.get(use) ?? {}))}`;
  const precedents: Record<string, Precedent[]> = {};
  for (const u of o.precedents ?? []) (precedents[key(u.component, u.props)] ??= []).push(u);
  // Each queued element's label fields, so the page can write a labels.jsonl row as it is.
  const items = entries.map((q) => {
    const e = byId.get(q.id);
    const pick = picks.get(q.id) ?? e;
    const alts = (e.alternatives ?? []).filter((a: any) => a?.use && a.use !== pick?.use).slice(0, 3);
    const mine = pick?.use ? precedents[key(pick.use, pick.props)] ?? [] : [];
    const examples = [...mine.filter((u) => u.shot), ...mine.filter((u) => !u.shot)].slice(0, 3);
    const altEx = alts[0] ? (precedents[key(alts[0].use, alts[0].props)] ?? []).slice(0, 1) : [];
    return {
      ...q, pick,
      label: { app: e.target, file: e.file, line: e.line, sourceRef: o.sourceRef?.(e) ?? 'worktree', elementHash: e.srcHash ?? hashText(String(e.snippet ?? e.id)) },
      examples, altExamples: altEx, usesCount: mine.length,
    };
  });
  const setAside = live.filter((e: any) => !e.review.ready).length;
  E.review = { items, setAside, ready: ready.length, system: o.system ?? [], precedentSource: o.precedents ? 'uses' : 'none' };
  return payload;
}
