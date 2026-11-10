/**
 * Keyboard review for Element Review by component. One key per action, no modifiers, so a reviewer can
 * work through a long list without the mouse. Keys never fire while typing (a note, a name, a search),
 * while a dialog is open, or with Ctrl, Cmd or Alt held, so the browser's own shortcuts still work.
 */

export type KeyAction = "next" | "prev" | "tick" | "confirm" | "change" | "note" | "open" | "clear" | "undo"

/** The keys, in the order the help line lists them. */
export const KEYS: { keys: string[]; action: KeyAction; says: string }[] = [
  { keys: ["J"], action: "next", says: "next place" },
  { keys: ["K"], action: "prev", says: "previous" },
  { keys: ["X"], action: "tick", says: "tick" },
  { keys: ["C"], action: "confirm", says: "confirm" },
  { keys: ["E"], action: "change", says: "change to…" },
  { keys: ["N"], action: "note", says: "note" },
  { keys: ["O"], action: "open", says: "open on its own" },
  { keys: ["U"], action: "undo", says: "undo" },
  { keys: ["Esc"], action: "clear", says: "clear ticks" },
]

const BY_KEY: Record<string, KeyAction> = { j: "next", k: "prev", x: "tick", c: "confirm", e: "change", n: "note", o: "open", u: "undo", escape: "clear" }

/** True when the key belongs to what the person is typing in, not to the review. */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== "string") return false
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable === true
}

/** The review action a key press asks for, or null when it isn't one (or shouldn't be taken now). */
export function keyAction(ev: { key: string; target: EventTarget | null; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, dialogOpen = false): KeyAction | null {
  if (ev.ctrlKey || ev.metaKey || ev.altKey || dialogOpen || typingIn(ev.target)) return null
  return BY_KEY[ev.key.toLowerCase()] ?? null
}
