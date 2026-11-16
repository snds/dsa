# Layouts

**Short version:** five low-fidelity screens, built from the dashboard's own UI kit
(`packages/dashboard/ui/src/components/ui`). Grey dashed boxes stand in for photos, drawings and
charts. Names are made up (`app-a`, `app-b`, `app-c`).

## How to look at them

- **Online:** a private copy is at <https://claude.ai/artifact/SPE63mrJQpViDaD9V2HjwX>. It opens on a
  phone too; the screens scroll sideways inside their frame there.
- **Locally:** open [`wireframes/index.html`](wireframes/index.html) in a browser. It is one
  self-contained file. Add `#inbox`, `#issue`, `#component`, `#published` or `#health` to jump to a
  screen.
- **Source:** [`packages/dashboard/ui/wireframes/main.tsx`](../../packages/dashboard/ui/wireframes/main.tsx).
  Rebuild from `packages/dashboard/ui` with
  `npx vite build --configLoader runner --config wireframes/vite.config.ts`. Nothing in the app
  imports it.

## The Figma file

The full design lives in Figma: <https://www.figma.com/design/8oUdMeweXlHGS48PgsMkOK>.
It has the tokens in Light and Dark, the components with every state, the serve and published
screens, the narrow-screen thread, the Apps and Settings pages, motion, and the D1–D6 options.
It is private to Sean's Figma team.

## The screens

1. **Inbox** (`#inbox`). Home. Issues grouped by component. Filters for *Waiting on you*, *Needs a
   person*, *In PR*. Every row and group header shows its thread state. Ticks and keys from Element
   Review carry over.
2. **Issue + pinned thread** (`#issue`). The case on the left: header, recommendation with "would
   change it", evidence open first (photo beside drawing, then places), decision bar. The issue's
   own thread on the right: *What the agent knows*, the approval ladder (Explain › Propose › Try ›
   Keep › Draft PR), a reply that cites what it looked at, and a proposal card.
3. **Component** (`#component`). System and System Usage in one page. *Confirm* / *Correct* for a
   component that needs a check. Its open issues with their thread states. A thread for the whole
   component.
4. **Published copy** (`#published`). The same issue on GitHub Pages. The thread is read-only
   history. *Discuss on GitHub* replaces the chat box. Answers go out by PR.
5. **Health** (`#health`). Each measure with its trend and a link to the issues that move it. How
   sure the scan is.

## What the layouts don't settle

- Exact visual design. These use the kit as it is, with no new tokens.
- The narrow-screen thread sheet. Described in [the IA](03-information-architecture.md#the-issue-page),
  not drawn.
- The Apps and Settings pages. They keep today's layout, apart from links into the Inbox.
