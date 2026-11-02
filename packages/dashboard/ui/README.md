# Dashboard UI

The React app behind the dashboard (`dsa serve`, the report, `dsa publish`). It builds to one script
and one stylesheet in `../templates/ui`, which the report embeds, so the page also opens from disk.
The build output is committed: running dsa never needs this build.

```sh
npx -y pnpm@10.28.0 --filter @snds/dsa-dashboard-ui install
npx -y pnpm@10.28.0 --filter @snds/dsa-dashboard build:ui
```

The design system's name in the UI comes from its profile (`label`), never from this code.

## Writing rules

- **Button labels:** a verb and at most one object, two or three words ("Run in the background",
  "Copy command", "Try again"). Four only to name a scope ("Create issues for all"). Sentence case,
  never Title Case. Anything longer is an explanation: put it in the description, helper text or a
  tooltip, not on the button.
- **Dialogs:** change padding with `[--dialog-pad:…]` on `DialogContent`, never `p-*`, so the footer
  still runs edge to edge (`test/dialog-padding.test.tsx` checks it).
