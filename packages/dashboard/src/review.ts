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
  if (mine) return mine;
  const plain = E.proposals?.[key];
  return plain ? { ...plain, own: false } : null;
}

/**
 * The element's own words, for comparing with a drawing's. With a photo, what it recorded, else the text its
 * source holds: the two a drawing is given. Not its label, which can be an aria-label nobody sees (an icon-only
 * button has no words to draw). With no photo's record, its label is all there is.
 */
const wordsOf = (e: any): string => String((e.shot?.content ? e.shot.content.text || e.words : e.label) ?? '').replace(/\s+/g, ' ').trim();
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
    return Boolean(p?.url) && p.check !== 'none' && !p.unstyled && drawnWithOwnWords(p, e);
  });
}

/** Can a person review this element? */
export function evidenceOf(E: any, e: any, pick: any): Evidence {
  const missing: Evidence['missing'] = [];
  const s = e.shot;
  let current: Evidence['current'] = null;
  if (!s) {
    if (e.staleShot) missing.push({ kind: 'stale', why: 'Its only photo is from an older run, so it may not show the code as it is now.', group: 'have only an old photo, from before the code changed', fix: 'Take the screenshots again.' });
    else if (e.reach?.why) missing.push(unreached(e));
    else missing.push({ kind: 'no-photo', why: 'There is no photo of it in the app.', group: 'have no photo in the app', fix: 'Take screenshots of the app (dsa run with screenshots on).' });
  } else if (s.blank) missing.push({ kind: 'blank', why: 'Its photo shows nothing: it may need a state the crawler could not set.', group: 'have a photo that shows nothing', fix: 'Add a flow that puts the page in that state.' });
  else if (s.covered) missing.push({ kind: 'covered', why: 'Something else covers it in its photo.', group: 'are covered by something else in their photos', fix: 'Take the photo again with the covering layer closed.' });
  else if (s.source === 'isolated') current = 'isolated';
  else if (s.drawn === 'markup') missing.push({ kind: 'markup', group: 'could only be drawn as markup, not as the app draws them', why: 'Only its markup could be drawn, not the element as the app draws it.', fix: 'Reach it in the running app, or record its props so it can be drawn as an isolated render.' });
  else if (s.drawn) missing.push({ kind: 'guessed', group: 'were drawn with guessed props, so they may not look like the real thing', why: 'It was drawn from the code with guessed props, so it may not look like the real thing.', fix: 'Reach it in the running app, or record its props so it can be drawn as an isolated render.' });
  else if (!s.tagged && (s.match ?? 0) < SHOT_MIN) missing.push({ kind: 'unsure-photo', group: 'have a photo that may be of a different element', why: 'Its photo may be of a different element that looks like it.', fix: 'Build the app with source tags, so the photo is found by its line.' });
  else current = 'live';
  if (pick?.verdict === 'replace' && pick.use) {
    const p = proposalFor(E, e, pick);
    const what = [pick.use, ...Object.entries(pick.props ?? {}).filter(([k]) => k !== 'render').map(([k, v]) => `${k} ${v}`)].join(', ');
    const container = CONTAINER_ROLES.has(e.role) || CONTAINER_ROLES.has(pick.role);
    if (p && p.check === 'none' && !p.url && (p.noSource || NO_SOURCE.test(p.note ?? ''))) missing.push({ kind: 'no-source', group: 'propose a component the system has nothing to draw from', why: `The system has nothing to draw ${pick.use} from.`, fix: `Add a story or source for ${pick.use}, or propose another component.` });
    else if (!p?.url) missing.push({ kind: 'not-drawn', group: "have a proposal that isn't drawn yet", why: `The proposal (${what}) isn't drawn yet.`, fix: 'Draw the proposals (dsa render).' });
    else if (p.check !== 'exact') missing.push({ kind: 'near-match', group: 'have a proposal drawn only as a near match', why: `The proposal (${what}) is only drawn as a near match, not with these props.`, fix: 'Draw the proposals (dsa render).' });
    // Drawn without the system's stylesheet it looks broken, and would be judged for that, not for the fit.
    else if (p.unstyled) missing.push({ kind: 'unstyled', group: "have a proposal that couldn't be drawn with the system's styles", why: "The proposal couldn't be drawn with the system's styles, so it wouldn't look like the real component.", fix: "Check the system's Storybook preview loads its stylesheet, then draw the proposals again (dsa render)." });
    // A stand-in icon reads as a different control; sample words as a different label: neither is decidable.
    else if (!container && /stand-in|^icon|icon .*couldn't be loaded/.test(p.content ?? '')) missing.push({ kind: 'stand-in-icon', group: "have a proposal drawn with a stand-in icon, not their own", why: "The proposal is drawn with a stand-in icon, not this element's own icon, so it may read as a different control.", fix: "Take the photo again so its icon is recorded, then draw the proposal again (dsa render)." });
    else if (!container && (e.ownHash || p.content) && !drawnWithOwnWords(p, e)) missing.push({ kind: 'not-own-words', group: "have a proposal drawn with other words than their own", why: p.own ? "The proposal's words aren't this element's own." : "The proposal shows the system's sample words, not this element's own.", fix: 'Draw the proposal again once its own words are known (a photo records them).' });
    // A swatch's marker, an icon font's glyph, a second line: the proposal must hold them too, or it reads as another control.
    else if (!container && s?.content && s.content.inner === undefined) missing.push({ kind: 'no-inner', group: "have a proposal that doesn't show their inner content", why: "The proposal doesn't show this element's inner content.", fix: 'Take the photo again so what it holds is recorded, then draw the proposal again (dsa render).' });
    else if (!container && s?.content?.inner && !p.inner) missing.push({ kind: 'no-inner', group: "have a proposal that doesn't show their inner content", why: "The proposal doesn't show this element's inner content.", fix: s.content.inner.lost ? 'A picture inside it comes from elsewhere and couldn\'t be copied. Compare the two in the app instead.' : 'Draw the proposal again (dsa render); if it stays missing, the system may not load the icon font it uses.' });
  }
  // Nobody can decide in a vacuum: with no clear answer and no candidate to look at, it's held out.
  if (pick?.verdict === 'unclear' && !candidatesOf(E, e).length) missing.push({ kind: 'no-candidates', group: 'have no clear answer and no candidate drawn to compare', why: 'dsa has no clear answer for it, and none of the candidates is drawn with its own content.', fix: 'Take the photo again and draw the proposals (dsa render), or answer it in Element Review.' });
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

/** Props that don't change how a system component looks, when the system doesn't list its axes. */
const NOT_LOOK = /^(type|form|name|value|disabled|tabIndex|role|href|to|target|rel|htmlFor|placeholder|autoFocus|asChild|render|open|defaultOpen|checked|defaultChecked)$/;

/** "Not at this size, but here's the same variant at sm." The element's pick first, then the nearest use. */
export function nearestLabel(use: string, want: Record<string, string>, have: Record<string, string>): string {
  const keys = [...new Set([...Object.keys(want), ...Object.keys(have)])];
  const differ = keys.filter((k) => want[k] !== have[k]), alike = keys.filter((k) => want[k] === have[k]);
  const at = (k: string) => (k === 'size' ? 'at' : 'in');
  const value = (k: string) => have[k] ?? 'its default';
  if (!differ.length) return `The app uses ${use} like this.`;
  const first = differ[0]!;
  const not = `Not ${at(first)} this ${differ.length > 1 ? 'combination' : first}`;
  const there = differ.map((k) => `${at(k)} ${value(k)}`).join(', ');
  return alike.length ? `${not}, but here's the same ${alike.join(' and ')} ${there}.` : `${not}, but here's ${use} ${there}.`;
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

/** One place the app already uses a system component, with its props and, when the crawler has one, its photo. */
export interface Precedent { app: string; file: string; line: number; component: string; props: Record<string, string>; /** Props set from the code, so their value isn't known. */ dynamic?: string[] | undefined; shot?: { url: string; box: any; page?: string | undefined; pageName: string } | null }

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
  const defaults = new Map((o.system ?? []).map((c) => [c.component, c.defaults ?? {}]));
  // A use matches on what the system's look depends on (its axes), not on type="button" and the like.
  const axesOf = new Map((o.system ?? []).map((c) => [c.component, Object.keys({ ...(c.axes ?? {}), ...(c.defaults ?? {}) })]));
  const look = (use: string, props: Record<string, unknown> | undefined) => {
    const axes = axesOf.get(use);
    const kept = Object.fromEntries(Object.entries(props ?? {}).filter(([k]) => (axes?.length ? axes.includes(k) : !NOT_LOOK.test(k))));
    return canonicalProps(kept, defaults.get(use) ?? {});
  };
  const key = (use: string, props: Record<string, unknown> | undefined) => `${use}|${JSON.stringify(look(use, props))}`;
  // A use with an axis set from the code might be anything: not an exact match, nor said to be.
  const unknownLook = (u: Precedent) => (u.dynamic ?? []).some((k) => k === '...' || (axesOf.get(u.component)?.length ? axesOf.get(u.component)!.includes(k) : !NOT_LOOK.test(k)));
  const precedents: Record<string, Precedent[]> = {};
  const byUse: Record<string, Precedent[]> = {};
  for (const u of o.precedents ?? []) { (byUse[u.component] ??= []).push(u); if (!unknownLook(u)) (precedents[key(u.component, u.props)] ??= []).push(u); }
  const photoFirst = (l: Precedent[]) => [...l.filter((u) => u.shot), ...l.filter((u) => !u.shot)];
  /** The nearest uses when none is exact: the most axes alike, labelled by what differs. */
  const nearestFor = (use: string, props: Record<string, unknown> | undefined) => {
    const want = look(use, props);
    const rank = (byUse[use] ?? []).filter((u) => !unknownLook(u)).map((u) => {
      const have = look(use, u.props);
      return { u, have, alike: Object.keys(want).filter((k) => want[k] === have[k]).length };
    }).sort((a, b) => b.alike - a.alike);
    const top = rank[0];
    if (!top) return null;
    const same = rank.filter((r) => JSON.stringify(r.have) === JSON.stringify(top.have)).map((r) => r.u);
    return { label: nearestLabel(use, want, top.have), examples: photoFirst(same).slice(0, 3), count: same.length };
  };
  // Each queued element's label fields, so the page can write a labels.jsonl row as it is.
  const items = entries.map((q) => {
    const e = byId.get(q.id);
    const pick = picks.get(q.id) ?? e;
    const alts = (e.alternatives ?? []).filter((a: any) => a?.use && a.use !== pick?.use).slice(0, 3);
    const mine = pick?.use ? precedents[key(pick.use, pick.props)] ?? [] : [];
    const examples = photoFirst(mine).slice(0, 3);
    const nearest = pick?.use && !mine.length ? nearestFor(pick.use, pick.props) : null;
    const own = pick?.use ? E.proposals?.[proposalKey(pick.use, pick.props)] : null;
    const scope = o.searched?.[e.target];
    const altEx = alts[0] ? (precedents[key(alts[0].use, alts[0].props)] ?? []).slice(0, 1) : [];
    return {
      ...q, pick,
      label: { app: e.target, file: e.file, line: e.line, sourceRef: o.sourceRef?.(e) ?? 'worktree', elementHash: e.srcHash ?? hashText(String(e.snippet ?? e.id)) },
      examples, altExamples: altEx, usesCount: mine.length,
      nearest, systemExample: !mine.length && own?.url && own.check === 'exact' && !own.unstyled ? { url: own.url } : null,
      // Said as "doesn't use it" only when the search read the whole app.
      searched: scope ? { files: scope.files, unread: scope.unread, whole: scope.files > 0 && scope.unread === 0 } : null,
    };
  });
  const setAside = live.filter((e: any) => !e.review.ready).length;
  E.review = { items, setAside, ready: ready.length, decideNow: open.length, system: o.system ?? [], precedentSource: o.precedents ? 'uses' : 'none' };
  return payload;
}
