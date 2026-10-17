import { Button, Item, Tooltip } from "@fixture/ui";

// Two raw buttons a library control should replace, one a whole-surface cell, and three that
// aren't raw: the library Button, a <button> handed to Item, and one handed to a Tooltip.
export function Screen({ onOpen }: { onOpen: () => void }) {
  return (
    <div>
      <button type="button" onClick={onOpen}>
        Cancel
      </button>
      <span>
        Sign in <button type="button">again</button>
      </span>
      <div role="grid">
        <button type="button" aria-label="15 October" />
      </div>
      <Button onClick={onOpen}>Save</Button>
      <Item render={<button type="button" onClick={onOpen} />}>A row</Item>
      <Tooltip render={<button type="button" />}>Help</Tooltip>
      <a href="/elsewhere">A link</a>
      <input aria-label="Search" />
    </div>
  );
}
