/**
 * What the review card actually shows, read from its rendered DOM. The trust rubric's card checks
 * (photo labelled, proposal labelled, side by side at one scale, the place opens the code) are judged
 * from these facts, not assumed from what this version of the card is meant to draw.
 *
 * `PROBE_CARDS` runs in any DOM: a published page in a real browser (dsa bench drives one through
 * @snds/dsa-review), or a test's happy-dom (`probeCards`). It is plain JavaScript in a string and uses
 * nothing from outside it, so a browser driver can send it to the page as it is.
 */
export interface CardFacts {
  /** The element this tile is for (data-element-id; pages from before it existed carry none). */
  id: string | null;
  /** The app badge beside the photo. */
  target: string | null;
  /** The place as the card writes it: "src/Toolbar.tsx:4". */
  place: string | null;
  /** Shown only as a small thumbnail of the same look, not as its own labelled photo. */
  thumb: boolean;
  /** The photo says what it is (live, isolated render, drawn), the app, file:line, and the match or how it was found. */
  photoLabel: boolean;
  /** The file:line opens the code viewer on that file. */
  opensCode: boolean;
  /** The proposal pane says "Proposed" (or which stand-in it is) and names the component. null: no proposal pane. */
  proposalLabel: boolean | null;
  /** The photo crop and the proposal are both drawn at their real CSS size, one above the other. null: no proposal pane. */
  sameScale: boolean | null;
}

/**
 * Every tile on the page, as `(doc, { click }) => Promise<CardFacts[]>`. With `click`, the place button is
 * pressed and the code viewer checked for the file, then closed; without it, a place that is an enabled
 * "Open the code" button counts.
 */
export const PROBE_CARDS = `async (doc, opts) => {
  const SOURCES = /Live app screenshot|Isolated render|Drawn from the app's code|Markup only/;
  const FOUND = /match \\d+%|matched by source tag|Isolated render|Drawn from the app's code|Markup only/;
  const win = doc.defaultView;
  const tick = () => new Promise((r) => win.setTimeout(r, 0));
  const text = (el) => ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  for (const slot of Array.from(doc.querySelectorAll('[data-slot="same-scale"]'))) {
    const app = slot.querySelector('[data-pane="app"]');
    if (!app) continue;
    const figure = slot.closest('figure');
    const label = text(app);
    const badge = app.querySelector('[title="The app this element is in"]');
    const code = app.querySelector('button[title="Open the code"]');
    const place = code ? text(code) : null;
    const target = badge ? text(badge) : null;
    const photoLabel = SOURCES.test(label) && Boolean(target) && Boolean(place && /:\\d+$/.test(place)) && FOUND.test(label);
    let opensCode = Boolean(code && !code.disabled);
    if (opensCode && opts && opts.click) {
      code.click();
      await tick(); await tick();
      const dialog = doc.querySelector('[role="dialog"]');
      const file = place.replace(/:\\d+$/, '').split('/').pop() || '';
      opensCode = Boolean(dialog && file && (dialog.textContent || '').includes(file));
      if (dialog) {
        dialog.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await tick(); await tick();
        const still = doc.querySelector('[role="dialog"]');
        const close = still && Array.from(still.querySelectorAll('button')).find((b) => /close/i.test(b.getAttribute('aria-label') || b.textContent || ''));
        if (close) { close.click(); await tick(); await tick(); }
      }
    }
    const proposed = slot.querySelector('[data-pane="proposed"]');
    const proposalLabel = proposed ? /Proposed|Closest variant|Its story as written/.test(text(proposed)) && Boolean(text(proposed.querySelector('b'))) : null;
    const sameScale = proposed ? Boolean(app.querySelector('[data-scale="1"]') && proposed.querySelector('img[data-scale="1"]')) : null;
    out.push({ id: figure ? figure.getAttribute('data-element-id') : null, target, place, thumb: false, photoLabel, opensCode, proposalLabel, sameScale });
    // The other elements of the same look: thumbnails, labelled only by their tooltip.
    for (const t of Array.from(figure ? figure.querySelectorAll('[aria-label^="The other"] button') : [])) {
      const m = (t.getAttribute('title') || '').match(/^(.*?) · (.*:\\d+)$/);
      out.push({ id: t.getAttribute('data-element-id'), target: m ? m[1] : null, place: m ? m[2] : null, thumb: true, photoLabel: false, opensCode: false, proposalLabel, sameScale: proposed ? false : null });
    }
  }
  return out;
}`;

/** Run the probe on a document in this process (a test's happy-dom). */
export function probeCards(doc: unknown, opts: { click?: boolean } = {}): Promise<CardFacts[]> {
  // eslint-disable-next-line no-new-func
  return (new Function(`return (${PROBE_CARDS})`))()(doc, opts);
}
