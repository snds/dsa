import { hashText } from '@snds/dsa';
import { lookRules } from '@snds/dsa/engine';
import { NO_SOURCE, SHOT_MIN, proposalKey } from './trust.js';

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
  missing: Missing[];
}

/**
 * One thing missing. `why` is the plain reason for this element; `kind` groups the same reason across
 * elements, and `group` says it for several ("12 aren't reached yet: …"). `detail` is the code-level
 * account (conditions, components), for engineers only.
 */
export interface Missing { why: string; fix: string; kind: string; group: string; detail?: string | undefined }

/** A control's words from the code, with the values the code fills in shown as "…": "Message on …: Open request …". */
export function stepWords(l: unknown): string {
  const t = String((l as any)?.label ?? l ?? '').replace(/\s+/g, ' ').trim();
  return t.replace(/\s+([:;,])/g, ' …$1').replace(/\s*[-–—:;,]+$/, ' …').replace(/^[-–—:;,]+\s*/, '… ').replace(/(…\s*){2,}/g, '… ').trim();
}

/** Why the crawler hasn't photographed it, in plain words, from how it is reached. */
function unreached(e: any): Missing {
  const r = e.reach ?? {};
  const detail = r.why ? String(r.why) : undefined;
  const fix = 'Add a route or a flow that opens it, or record it while someone uses the app (dsa record).';
  const steps = (r.steps ?? []).map(stepWords).filter(Boolean);
  const last = (r.gates ?? [])[r.gates?.length - 1];
  if (r.status === 'page')
    return { kind: 'unphotographed', why: "It shows on a page, but the crawler hasn't photographed it yet.", group: "show on a page, but the crawler hasn't photographed them yet", fix: 'Take the screenshots again; if it stays missing, add the page as a route.', detail };
  if (steps.length) {
    const first = `opening “${steps[0]}”`;
    return { kind: 'flow', why: `The crawler hasn't reached it yet: it only shows after steps in a flow, such as ${first}.`, group: `aren't reached yet: they only show after steps in a flow, such as ${first}`, fix, detail };
  }
  if (last?.kind === 'overlay') {
    const where = last.overlay ? `a ${last.overlay}` : 'a menu or a dialog';
    return { kind: 'overlay', why: `The crawler hasn't reached it yet: it only shows inside ${where}, and nothing it found opens that.`, group: `aren't reached yet: they only show inside a menu, dialog or panel nothing found opens`, fix, detail };
  }
  return { kind: 'state', why: "The crawler hasn't reached it yet: it only shows in a state the crawler can't set yet, such as a setting, a filter or some data.", group: "aren't reached yet: they only show in a state the crawler can't set yet, such as a setting, a filter or some data", fix, detail };
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
  const plain = E.proposals?.[key];
  const p = atWidthOf(mine ?? (plain ? { ...plain, own: false } : null), e);
  if (!p || !wholeForPart(p, e)) return p;
  // One small part proposed as the whole it belongs to: compared with that part, when one is drawn.
  for (const a of e.alternatives ?? []) {
    if (!a?.use || a.use === pick.use) continue;
    const part = atWidthOf(e.ownHash ? E.proposals?.[`${proposalKey(a.use, a.props)}#${e.ownHash}`] : E.proposals?.[proposalKey(a.use, a.props)], e);
    if (part?.url && !wholeForPart(part, e)) return { ...part, partOf: pick.use, partUse: a.use };
  }
  return { ...p, wholeForPart: true };
}

/** A drawing that fills its container was drawn at the widths of its elements: the one nearest this element's. */
export function atWidthOf(p: any, e: any): any {
  if (!p?.sizes?.length) return p;
  const w = e?.shot?.box?.w;
  const s = w ? [...p.sizes].sort((a: any, b: any) => Math.abs(a.for - w) - Math.abs(b.for - w))[0] : p.sizes[0];
  return { ...p, url: s.url, w: s.w, h: s.h, wider: Boolean(s.wider), cut: Boolean(s.cut) };
}

/**
 * Is the drawing many times the element? Then it's what the element belongs to, not what it would become.
 * Width a component only has because it fills its container isn't counted: that's the page it was drawn on.
 */
export function wholeForPart(p: any, e: any): boolean {
  const b = e?.shot?.box;
  if (!p?.w || !p?.h || !b?.w || !b?.h) return false;
  return (p.fills ? Math.min(p.w, b.w) : p.w) * p.h >= 9 * b.w * b.h;
}

/**
 * The element's own words, for comparing with a drawing's. With a photo, what it recorded, else the text its
 * source holds: the two a drawing is given. Not its label, which can be an aria-label nobody sees (an icon-only
 * button has no words to draw). With no photo's record, its label is all there is.
 */
const wordsOf = (e: any): string => String((e.shot?.content ? e.shot.content.text || e.shot.content.value || e.shot.content.placeholder || e.words : e.label) ?? '').replace(/\s+/g, ' ').trim();
/** A drawing shows the element's own words: drawn with them, and the words it drew are the element's. */
export function drawnWithOwnWords(p: any, e: any): boolean {
  if (!p?.own) return false;
  if (typeof p.text !== 'string') return !wordsOf(e);
  return p.text.replace(/\s+/g, ' ').trim() === wordsOf(e);
}

/** What a card with no clear proposal can show: its candidates drawn with the element's own content. */
export function candidatesOf(E: any, e: any): any[] {
  return (e.alternatives ?? []).filter((a: any) => {
    if (!a?.use) return false;
    const p = proposalFor(E, e, { verdict: 'replace', use: a.use, props: a.props });
    return Boolean(p?.url) && p.check !== 'none' && !p.unstyled && !p.cut && drawnWithOwnWords(p, e);
  });
}

/** A box this small holds nothing a person can compare: what the capture landed on, not the element. */
const tinyPhoto = (box: any): boolean => Boolean(box) && Math.min(box.w, box.h) <= 8;

/** Can a person review this element? */
export function evidenceOf(E: any, e: any, pick: any): Evidence {
  const missing: Evidence['missing'] = [];
  const s = e.shot;
  let current: Evidence['current'] = null;
  if (!s) {
    if (e.staleShot) missing.push({ kind: 'stale', why: 'Its only photo is from an older run, so it may not show the code as it is now.', group: 'have only an old photo, from before the code changed', fix: 'Take the screenshots again.' });
    else if (e.reach?.why) missing.push(unreached(e));
    else missing.push({ kind: 'no-photo', why: 'There is no photo of it in the app.', group: 'have no photo in the app', fix: 'Take screenshots of the app (dsa run with screenshots on).' });
  } else if (s.blank && tinyPhoto(s.box)) missing.push({ kind: 'tiny-photo', why: `Its photo is only ${s.box.w} × ${s.box.h} px, so the capture found nothing usable to compare.`, group: 'have a photo only a few pixels across, so the capture found nothing usable', fix: 'Add a flow that puts the page in the state that shows it, then take the screenshots again.' });
  else if (s.blank) missing.push({ kind: 'blank', why: 'Its photo shows nothing: it may need a state the crawler could not set.', group: 'have a photo that shows nothing', fix: 'Add a flow that puts the page in that state.' });
  else if (s.covered) missing.push({ kind: 'covered', why: 'Something else covers it in its photo.', group: 'are covered by something else in their photos', fix: 'Take the photo again with the covering layer closed.' });
  else if (s.source === 'isolated') current = 'isolated';
  else if (s.drawn === 'markup') missing.push({ kind: 'markup', group: 'could only be drawn as markup, not as the app draws them', why: 'Only its markup could be drawn, not the element as the app draws it.', fix: 'Reach it in the running app, or record its props so it can be drawn as an isolated render.' });
  else if (s.drawn) missing.push({ kind: 'guessed', group: 'were drawn with guessed props, so they may not look like the real thing', why: 'It was drawn from the code with guessed props, so it may not look like the real thing.', fix: 'Reach it in the running app, or record its props so it can be drawn as an isolated render.' });
  else if (!s.tagged && (s.match ?? 0) < SHOT_MIN) missing.push({ kind: 'unsure-photo', group: 'have a photo that may be of a different element', why: 'Its photo may be of a different element that looks like it.', fix: 'Build the app with source tags, so the photo is found by its line.' });
  else current = 'live';
  // A field's words are what the reviewer compares; a photo from before they were recorded can't show that they match.
  if (s?.content && !s.drawn && /^<(input|textarea|select)\b/i.test(e.snippet ?? '') && !('value' in s.content)) missing.push({ kind: 'no-field-words', group: "have a photo that didn't record what's typed in them", why: "Its photo didn't record what's typed in it, so the proposal can't be drawn with it.", fix: 'Take the screenshots again.' });
  if (pick?.verdict === 'replace' && pick.use) {
    const p = proposalFor(E, e, pick);
    const what = [pick.use, ...Object.entries(pick.props ?? {}).filter(([k]) => k !== 'render').map(([k, v]) => `${k} ${v}`)].join(', ');
    // Said plainly to be an example, so it isn't judged as this element's content. Nothing else is let off.
    const example = Boolean(p?.example);
    // A photo that shows nothing can't say how big the element is, so it can't say it's a small part of anything.
    if (p?.wholeForPart) { if (!s?.blank) missing.push({ kind: 'whole-for-part', group: 'propose the whole of a component for one small part of it', why: `${pick.use} is the whole component, and this element is one small part of it. No drawing shows that part.`, fix: 'Decide it with the whole component, or draw the part (dsa render).' }); }
    else if (p && p.check === 'none' && !p.url && (p.noSource || NO_SOURCE.test(p.note ?? ''))) missing.push({ kind: 'no-source', group: 'propose a component the system has nothing to draw from', why: `The system has nothing to draw ${pick.use} from.`, fix: `Add a story or source for ${pick.use}, or propose another component.` });
    else if (!p?.url) missing.push({ kind: 'not-drawn', group: "have a proposal that isn't drawn yet", why: `The proposal (${what}) isn't drawn yet.`, fix: 'Draw the proposals (dsa render).' });
    else if (p.check !== 'exact') missing.push({ kind: 'near-match', group: 'have a proposal drawn only as a near match', why: `The proposal (${what}) is only drawn as a near match, not with these props.`, fix: 'Draw the proposals (dsa render).' });
    // Drawn without the system's stylesheet it looks broken, and would be judged for that, not for the fit.
    else if (p.unstyled) missing.push({ kind: 'unstyled', group: "have a proposal that couldn't be drawn with the system's styles", why: "The proposal couldn't be drawn with the system's styles, so it wouldn't look like the real component.", fix: "Check the system's Storybook preview loads its stylesheet, then draw the proposals again (dsa render)." });
    // Compared by what shows: a word cut short, or no word at all, can't be judged against the element's.
    else if (p.cut) missing.push({ kind: 'cut-off', group: 'have a proposal whose words are cut off in its drawing', why: "The proposal's words are cut off in its drawing, so it can't be compared.", fix: "Check how the component handles long words, or propose another component." });
    // A stand-in icon reads as a different control; sample words as a different label: neither is decidable.
    else if (!example && /stand-in|^icon|icon .*couldn't be loaded/.test(p.content ?? '')) missing.push({ kind: 'stand-in-icon', group: "have a proposal drawn with a stand-in icon, not their own", why: "The proposal is drawn with a stand-in icon, not this element's own icon, so it may read as a different control.", fix: "Take the photo again so its icon is recorded, then draw the proposal again (dsa render)." });
    else if (!example && (e.ownHash || p.content) && !drawnWithOwnWords(p, e)) missing.push({ kind: 'not-own-words', group: "have a proposal drawn with other words than their own", why: p.own ? "The proposal's words aren't this element's own." : "The proposal shows the system's sample words, not this element's own.", fix: 'Draw the proposal again once its own words are known (a photo records them).' });
    // A swatch's marker, an icon font's glyph, a second line: the proposal must hold them too, or it reads as another control.
    else if (!example && s?.content && s.content.inner === undefined) missing.push({ kind: 'no-inner', group: "have a proposal that doesn't show their inner content", why: "The proposal doesn't show this element's inner content.", fix: 'Take the photo again so what it holds is recorded, then draw the proposal again (dsa render).' });
    else if (!example && s?.content?.inner && !p.inner) missing.push({ kind: 'no-inner', group: "have a proposal that doesn't show their inner content", why: "The proposal doesn't show this element's inner content.", fix: s.content.inner.lost ? 'A picture inside it comes from elsewhere and couldn\'t be copied. Compare the two in the app instead.' : 'Draw the proposal again (dsa render); if it stays missing, the system may not load the icon font it uses.' });
  }
  // Nobody can decide in a vacuum: with no clear answer and no candidate to look at, it's held out.
  if (pick?.verdict === 'unclear' && !candidatesOf(E, e).length) missing.push({ kind: 'no-candidates', group: 'have no clear answer and no candidate drawn to compare', why: 'dsa has no clear answer for it, and none of the candidates is drawn with its own content.', fix: 'Take the photo again and draw the proposals (dsa render), or answer it in Element Review.' });
  return { ready: !missing.length, current, missing };
}

/** A page's address in plain words: "#/requests/table/sheet/add-request" → "Requests › Table › Sheet › Add request". */
export function pageName(url: string | null | undefined): string {
  if (!url) return 'an unknown page';
  let route = url;
  try { const u = new URL(url); route = u.hash.length <= 1 ? u.pathname : u.hash[1] === '/' || /^\/(index\.html?)?$/.test(u.pathname) ? u.hash.slice(1) : `${u.pathname}/${u.hash.slice(1)}`; } catch { /* a bare path */ }
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

/** One axis of a look, in words: "the outline variant", "size sm". A bare "in dark" would read as dark mode. */
function axisWords(k: string, v: string | undefined): string {
  if (v === undefined || v === 'default') return `the default ${k}`;
  if (v === 'true') return k;
  if (v === 'false') return `not ${k}`;
  return k === 'size' ? `size ${v}` : `the ${v} ${k}`;
}

/** How a use's look differs from what's proposed, for its tile: "the outline variant, size sm". */
function differsText(want: Record<string, string>, have: Record<string, string>): string {
  return [...new Set([...Object.keys(want), ...Object.keys(have)])].filter((k) => want[k] !== have[k]).sort((a, b) => Number(a === 'size') - Number(b === 'size')).map((k) => axisWords(k, have[k])).join(', ');
}

/**
 * What a use really has in common with what's proposed. Every look fills in its defaults, so two looks both at
 * the default size aren't alike for it: a link and a dark button at the default size share nothing to see. The
 * variant is the exception, since the same variant at another size is the closest thing there is.
 */
export function sharedAxes(want: Record<string, string>, have: Record<string, string>, defaults: Record<string, string>): string[] {
  return Object.keys(want).filter((k) => want[k] === have[k] && (k === 'variant' || want[k] !== defaults[k]));
}
const closeness = (shared: string[]) => shared.reduce((n, k) => n + (k === 'size' ? 1 : 2), 0);

const NO_PHOTO_WHY: Record<string, string> = {
  hidden: 'it was on the page, but hidden behind something closed, such as a menu or a tab',
  covered: 'something covers it in every photo',
  blank: 'its photos came out blank',
  'not-seen': "it didn't show on any page dsa opened, so it may only show after steps dsa can't take",
  'out-of-time': 'dsa ran out of time before reaching it (the next screenshots run carries on)',
  untried: "dsa hasn't photographed it yet",
};
/** Why no use has a photo, from what the crawler saw of each, in plain words. The likeliest to be fixable first. */
function noPhotoLine(use: string, uses: Precedent[]): { line: string; why: string } {
  const has = (w: string) => uses.some((u) => (u.missed ?? 'untried') === w);
  const why = ['hidden', 'covered', 'blank', 'out-of-time', 'untried', 'not-seen'].find(has) ?? 'untried';
  const n = uses.length;
  return { why, line: `The app uses ${use} in ${n === 1 ? 'one place' : `${n} places`}, but dsa has no photo of ${n === 1 ? 'it' : 'them'}: ${NO_PHOTO_WHY[why]}.` };
}

/** What sits above a card's photos of other looks. It speaks for every tile under it, so all of them share what it says they share. */
export function nearestLabel(use: string, want: Record<string, string>, have: Record<string, string>, o: { photo?: boolean; shared?: string[]; many?: boolean } = {}): string {
  const photo = o.photo ?? true, shared = o.shared ?? [];
  const there = differsText(want, have);
  if (!there) return photo ? `The app uses ${use} like this.` : `The app uses ${use} like this, but dsa has no photo of it yet.`;
  if (!photo) return `The app uses ${use} with ${there}, but dsa has no photo of it yet.`;
  if (shared.length) return `dsa has no photo of this look. ${o.many ? 'Here are uses' : "Here's a use"} with the same ${shared.join(' and ')}.`;
  return `dsa has no photo of this look. Here's how this app uses ${use} elsewhere.`;
}

/** The count that doesn't flatter: a photo of another look isn't a photo of what's proposed, and one photo on many cards is one photo. */
export function photosLine(p: { cards: number; sameLook: number; otherLook: number; elsewhere: number; labOnly: number; none: number; distinctPhotos: number; mostShown: number }): string {
  return `Review cards: ${p.cards}. Photo in the look proposed, in the product: ${p.sameLook}. Only another look in the product: ${p.otherLook} (${p.elsewhere} of them just how the app uses it elsewhere). Only from a lab page: ${p.labOnly}. No photo: ${p.none}. ${p.distinctPhotos} different photos, none on more than ${p.mostShown} cards.`;
}

export interface ReviewQueueEntry { id: string; why: 'decide' | 'disagree' | 'audit'; note?: string | undefined }

/**
 * Can a person decide this element now? The one rule both review pages use: Element Review counts these
 * under "Need a decision", and Label Review offers every one of them. Live, open (a person must decide it
 * and no one has), with a real photo and a real proposal (its evidence is ready).
 */
export function canDecideNow(e: any): boolean {
  return Boolean(e?.review?.ready) && !e.exception && e.reach?.status !== 'unused' && e.verdict !== 'ignore' && !e.decided && Boolean(e.needsHuman);
}

/**
 * Which element a label is about: its app, file and line, the source revision, and a hash of its source
 * text. The same for a report's element (srcHash) and the engine's (source), so an answer given on either
 * side names the same element.
 */
export function labelIdentity(e: any, sourceRef?: string): { app: string; file: string; line: number; sourceRef: string; elementHash: string } {
  const elementHash = e.srcHash ?? (typeof e.source === 'string' ? hashText(e.source) : hashText(String(e.snippet ?? e.id)));
  return { app: e.target, file: e.file, line: e.line, sourceRef: sourceRef ?? 'worktree', elementHash };
}

/** One place the app already uses a system component, with its props and, when the crawler has one, its photo. */
export interface Precedent { /** From a lab, specimen or demo page, not the product. */ lab?: boolean | undefined; app: string; file: string; line: number; component: string; props: Record<string, string>; /** Why it has no photo, as the crawler saw it. */ missed?: string | undefined; /** Props set from the code, so their value isn't known. */ dynamic?: string[] | undefined; shot?: { url: string; box: any; page?: string | undefined; pageName: string } | null }

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
  /** How much of each app the search for precedents read; absent when it didn't search itself. */
  searched?: Record<string, { files: number; unread: number }> | undefined;
  sourceRef?: (e: any) => string;
} = {}): any {
  const E = payload.elements;
  if (!E) return payload;
  const picks = picksOf(payload);
  const live = (E.evals ?? []).filter((e: any) => !e.exception && e.reach?.status !== 'unused' && e.verdict !== 'ignore');
  for (const e of E.evals ?? []) {
    const pick = picks.get(e.id) ?? (e.decided ? e.decided.decision : e);
    e.review = { ...evidenceOf(E, e, pick), pageName: pageName(e.shot?.page) };
    e.review.decideNow = canDecideNow(e);
  }
  const ready = live.filter((e: any) => e.review.ready);
  // The queue: every element a person can decide now (the ones Element Review counts), then what
  // `dsa labels queue` chose (disagreements, then its audit), kept only where it can be reviewed; else a
  // tenth of the sure "ready" ones drawn at random, the same draw each time, to check them.
  const byId = new Map<string, any>(live.map((e: any) => [e.id, e]));
  const open: ReviewQueueEntry[] = live.filter(canDecideNow).map((e: any) => ({ id: e.id, why: 'decide' as const }));
  let more: ReviewQueueEntry[];
  if (o.queue?.length) more = o.queue.filter((q) => byId.get(q.id)?.review.ready);
  else {
    const share = o.audit ?? 0.1;
    const draw = (id: string) => parseInt(hashText(`${o.seed ?? 'dsa'}\u0001${id}`).slice(0, 8), 16) / 0xffffffff;
    more = ready.filter((e: any) => !e.decided && !e.needsHuman && draw(e.id) < share).map((e: any) => ({ id: e.id, why: 'audit' as const }));
  }
  const queued = new Set(open.map((q) => q.id));
  const entries = [...open, ...more.filter((q) => !queued.has(q.id) && (queued.add(q.id), true))];
  // A use matches on what the system's look depends on (its axes), not on type="button" and the like: the crawler's rule too.
  const rules = lookRules(o.system);
  const look = rules.look, key = rules.key;
  // A use with an axis set from the code might be anything: not an exact match, nor said to be.
  const unknownLook = (u: Precedent) => rules.unknown(u.component, u.dynamic);
  const precedents: Record<string, Precedent[]> = {};
  const byUse: Record<string, Precedent[]> = {};
  for (const u of o.precedents ?? []) { (byUse[u.component] ??= []).push(u); if (!unknownLook(u)) (precedents[key(u.component, u.props)] ??= []).push(u); }
  // Only a photo says how the app uses it. Without one, a tile only repeats the system's own drawing.
  const photos = (l: Precedent[]) => l.filter((u) => u.shot);
  // Cards that differ shouldn't all show the same picture: the photos shown least so far first, from different pages where there are any.
  const shownSoFar = new Map<string, number>();
  const varied = <T extends { shot?: Precedent['shot'] }>(list: T[], room: number): T[] => {
    const n = (x: T) => shownSoFar.get(x.shot?.url ?? '') ?? 0;
    const order = list.map((x, i) => ({ x, i })).sort((a, b) => n(a.x) - n(b.x) || a.i - b.i).map((r) => r.x);
    const out: T[] = [], pages = new Set<unknown>();
    for (const x of order) if (out.length < room && !pages.has(x.shot?.page)) { out.push(x); pages.add(x.shot?.page); }
    for (const x of order) if (out.length < room && !out.includes(x)) out.push(x);
    for (const x of out) shownSoFar.set(x.shot?.url ?? '', n(x) + 1);
    return out;
  };
  // A lab's photo only when the product has none.
  const productFirst = <T extends { lab?: boolean | undefined }>(l: T[]): T[] => { const real = l.filter((u) => !u.lab); return real.length ? real : l; };
  /**
   * With no photo of the look itself, what else this app can show. Uses sharing a real axis, closest first; the
   * same variant is worth up to three tiles, a shared size alone only one. Sharing nothing, one tile, said to be
   * how the app uses it elsewhere and not called close. Every tile shares what the heading says.
   */
  const nearestFor = (app: string, use: string, props: Record<string, unknown> | undefined, labToo: boolean) => {
    const want = look(use, props), wanted = JSON.stringify(want), defaults = rules.defaults(use);
    const all = (byUse[use] ?? []).filter((u) => u.app === app);
    const rank = all.filter((u) => !unknownLook(u)).map((u) => { const have = look(use, u.props), shared = sharedAxes(want, have, defaults); return { u, have, shared, close: closeness(shared) }; }).filter((r) => JSON.stringify(r.have) !== wanted).sort((a, b) => b.close - a.close);
    const set = all.filter(unknownLook);
    if (!rank.length && !set.length) return null;
    const count = rank.length + set.length;
    // A product photo of any look before a lab's, however close the lab's is.
    const best = rank.find((r) => r.u.shot && !r.u.lab) ?? (labToo ? rank.find((r) => r.u.shot) : undefined);
    if (best) {
      const alike = rank.filter((r) => r.u.shot && !r.u.lab === !best.u.lab && r.shared.join() === best.shared.join()).map((r) => ({ ...r.u, differs: differsText(want, r.have) }));
      const examples = varied(alike, best.close >= 2 && !best.u.lab ? 3 : 1);
      return { kind: best.close ? 'close' : 'elsewhere', label: nearestLabel(use, want, best.have, { shared: best.shared, many: examples.length > 1 }), examples, count };
    }
    const setPhotos = photos(set).filter((u) => labToo || !u.lab);
    const examples = varied(productFirst(setPhotos).map((u) => ({ ...u, differs: 'its look is set in the code' })), 1);
    const top = rank[0];
    const label = !examples.length && top ? nearestLabel(use, want, top.have, { photo: false }) : `The app sets ${use}'s look in its code, so dsa can't say which it is${examples.length ? '.' : ', and has no photo of it yet.'}`;
    return { kind: examples.length ? 'set-in-code' : 'none', label, examples, count };
  };
  // Each queued element's label fields, so the page can write a labels.jsonl row as it is.
  const items = entries.map((q) => {
    const e = byId.get(q.id);
    const pick = picks.get(q.id) ?? e;
    const alts = (e.alternatives ?? []).filter((a: any) => a?.use && a.use !== pick?.use).slice(0, 3);
    // With no clear pick, the closest candidate is what there is to ask about.
    const about = pick?.use ? pick : alts[0] ?? null;
    // The app under review: its own uses, not another app's.
    const inApp = (l: Precedent[] | undefined) => (l ?? []).filter((u) => u.app === e.target);
    const mine = about ? inApp(precedents[key(about.use, about.props)]) : [];
    const examples = varied(photos(mine).filter((u) => !u.lab), 3);
    // The look on a lab page shows the look but not the product, so it comes with the product's nearest, after it.
    const labExamples = examples.length ? [] : varied(photos(mine), 1);
    // One photo of the look itself beats any number of near ones.
    const found = about && !examples.length ? nearestFor(e.target, about.use, about.props, !labExamples.length) : null;
    const nearest = found && labExamples.length ? (found.examples.length ? { ...found, label: found.label.replace('dsa has no photo of this look.', 'dsa has no photo of this look in the product.') } : null) : found;
    const everyUse = about ? inApp(byUse[about.use]) : [];
    const own = pick?.use ? E.proposals?.[proposalKey(pick.use, pick.props)] : null;
    const scope = o.searched?.[e.target];
    const altEx = alts[0] && alts[0] !== about ? varied(productFirst(photos(inApp(precedents[key(alts[0].use, alts[0].props)]))), 1) : [];
    const noPhoto = about && !examples.length && !labExamples.length && !nearest?.examples.length && everyUse.length ? noPhotoLine(about.use, everyUse) : null;
    return {
      ...q, pick, about,
      label: labelIdentity(e, o.sourceRef?.(e)),
      examples, labExamples, altExamples: altEx, usesCount: mine.filter((u) => !u.lab).length,
      nearest, noPhoto, systemExample: !mine.length && own?.url && own.check === 'exact' && !own.unstyled && !own.bare ? { url: own.url } : null,
      // Said as "doesn't use it" only when the search read the whole app.
      searched: scope ? { files: scope.files, unread: scope.unread, whole: scope.files > 0 && scope.unread === 0 } : null,
    };
  });
  const sameLook = items.filter((i: any) => i.examples.length).length;
  const otherLook = items.filter((i: any) => !i.examples.length && i.nearest?.examples.some((x: any) => !x.lab));
  // Every photo on the card is from a lab: it shows the look, not how the product uses it.
  const labOnly = items.filter((i: any) => !i.examples.length && !i.nearest?.examples.some((x: any) => !x.lab) && (i.labExamples.length || i.nearest?.examples.length)).length;
  const photoCards = sameLook + otherLook.length + labOnly;
  // The honest measure: a photo of another look on every card would still leave a person guessing. A photo counts once however many cards show it.
  const timesShown = new Map<string, number>();
  for (const i of items as any[]) for (const url of new Set<string>([...i.examples, ...i.labExamples, ...(i.nearest?.examples ?? []), ...i.altExamples].map((x: any) => x.shot.url))) timesShown.set(url, (timesShown.get(url) ?? 0) + 1);
  const whyNot: Record<string, number> = {};
  for (const i of items) if (!i.examples.length && !i.labExamples.length && !i.nearest?.examples.length) { const w = i.noPhoto?.why ?? (i.about ? 'no-uses' : 'no-candidate'); whyNot[w] = (whyNot[w] ?? 0) + 1; }
  const setAside = live.filter((e: any) => !e.review.ready).length;
  E.review = { items, photos: { cards: items.length, sameLook, otherLook: otherLook.length, elsewhere: otherLook.filter((i: any) => i.nearest.kind === 'elsewhere').length, labOnly, none: items.length - photoCards, withPhoto: photoCards, distinctPhotos: timesShown.size, mostShown: Math.max(0, ...timesShown.values()), without: whyNot }, setAside, ready: ready.length, decideNow: open.length, system: o.system ?? [], precedentSource: o.precedents ? 'uses' : 'none' };
  return payload;
}
