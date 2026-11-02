/**
 * Review text in plain words. The scanner's reasons and notes name what it read in the code
 * (aria-pressed, role="tab", .map(), class names); a reviewer approving a card needs what that means.
 * The card shows the plain line and keeps the original under Technical details.
 */

/** Code on the face of a card: attribute names, role values, .map(), braces, tags, prop assignments. */
export const CODE_TERMS = /\baria-[a-z]+|\brole\s*=|\.map\(|[{}]|<\/?[a-zA-Z][\w.-]*[\s>/]|\bclassName\b|\bdata-[a-z][\w-]*|\b[a-z][\w]*="[^"]*"/;

// What an ARIA attribute says about the element, as a noun phrase.
const ARIA: Record<string, string> = {
  'aria-pressed': 'an on/off pressed state',
  'aria-selected': 'a selected state',
  'aria-checked': 'a checked state',
  'aria-expanded': 'an open/closed state',
  'aria-haspopup': 'a pop-up it opens',
  'aria-controls': 'a link to the part it controls',
  'aria-current': 'a "current item" mark',
  'aria-label': 'an accessible name',
  'aria-labelledby': 'an accessible name from other text',
  'aria-describedby': 'a description from other text',
  'aria-hidden': 'hidden from screen readers',
  'aria-disabled': 'a disabled state',
  'aria-invalid': 'an error state',
  'aria-live': 'announcements as it changes',
  'aria-modal': 'a modal mark',
  'aria-orientation': 'a direction',
  'aria-sort': 'a sort order',
};

/**
 * The line in plain words, or null when what's left is still code (it then appears only under
 * Technical details). Never invents meaning: an unknown attribute or term leaves the line technical.
 */
export function plainText(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  let t = text;
  // "Styling Toggle won't keep: btn, btn-ghost." names classes: say what it means.
  t = t.replace(/^Styling (.+?) won't keep: [^.]*\.?$/, (_, c) => `Some of its own styling won't carry over to ${c}.`);
  // "aria-pressed: a pressed/unpressed latch." leads with the attribute: the rest already says it.
  t = t.replace(/^aria-[a-z]+:\s*(?:an?\s+)?/, 'It works as a ');
  // A parenthesis that only restates a prop assignment: (variant="destructive").
  t = t.replace(/\s*\((?:[a-z][\w-]*="[^"]*"[,;\s]*)+\)/g, '');
  // .map() / a .map over rows: a list built from data.
  t = t.replace(/(?:\b(?:a|an) )?\.map\(\)?(?: over \w+(?:\.\w+)*)?/g, 'a list built from data');
  // role="tab" / role=tab
  t = t.replace(/\brole\s*=\s*"?([a-z]+)"?/g, (_, r) => `the ${r} role`);
  // Attributes with a known meaning: "an aria-label" → "an accessible name".
  t = t.replace(/\b(?:an? |the )?(aria-[a-z]+)\b/g, (m, a: string) => (ARIA[a] ? ARIA[a]! : m));
  // <button> → button element
  t = t.replace(/<([a-z][\w-]*)>/g, (_, tag) => `${tag} element`);
  t = t.replace(/\s{2,}/g, ' ').trim();
  return CODE_TERMS.test(t) ? null : t;
}

/** Each reason with its plain line (null: technical only). */
export function withPlain<T extends { text: string }>(reasons: T[]): (T & { plain: string | null })[] {
  return reasons.map((r) => ({ ...r, plain: plainText(r.text) }));
}
