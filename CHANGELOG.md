# Changelog

All notable changes to `@snds/dsa` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Drawing from the app's code works for components that can't render alone. The mount wraps the
  component in every provider the live app has at that point (the store, theme, query client or router its
  entry file sets up, and ones deeper in the tree), read off the running page with their live values. It
  fills required props from the component's types, from how its body uses them, and from the literal values
  a call site passes, before the gates the scan traced. Components a file declares without exporting can be
  mounted too (the tagger keeps them).
- Every element that isn't reached live gets its own line in the log: drawn from the app's code, drawn as
  markup with the reason it wasn't mounted, or not drawn with the reason. A summary groups the reasons.

- Proposals are drawn without depending on stories. The system's component is mounted straight from its
  source through its own Vite, on a page that loads its Storybook preview file (CSS, providers,
  decorators), with the proposal's props and the element's own words and icon. Parts that live inside
  something closed are drawn inside their family, opened; parts that need data get empty lists, and a
  table drawn without its rows says so. Stories are used when the source doesn't draw it exactly.
  `rendered.harness: false` draws from stories only.
- An element's own content comes from its source when it has no photo: the icon component inside it
  (imported and drawn) or an inline `<svg>` from its JSX, beside its words and accessible name.
- Props are confirmed from a drawn element's classes when it shows no `data-variant` or `data-size`:
  signatures now record the classes each `cva` value adds (`axisClasses`).
- `scripts/proposal-gaps.mjs` counts, on a published dashboard, why proposals aren't drawn exactly with
  their element's own content.

### Added

- For people reviewing a proposal: each live photo gets a wider photo of the page around it (`context`:
  about 800 × 500, with where the element sits in it), and the app's own uses of design-system components
  are photographed as examples (`uses` in shots/index.json, keyed "file:line", up to 3 per component). The
  tagger marks each component use with `data-dsa-use` when dsa starts the app; it reaches the page when the
  component passes its props on.
- Exploring is guided by coverage (Chromium's JS coverage): each control is scored by the code it runs for
  the first time in the files of what's still missing, and below the top level only a control that ran
  some is followed further. The log says how much new code each page's exploring ran and which control ran
  the most. `shots.coverage: false` turns it off.
- An opt-in reach manifest (docs/reach-manifest.md). A dev build's `window.__DSA__ = { routes(), states(),
  go(name), seed() }` puts its routes first and each named state on in turn (those whose `reveals` name a
  missing element's file first); `dsa.reach.json` beside the app adds routes, and states that are a route
  with storage seeded. Reaching an element becomes a lookup.
- Exact state setters. In tagged files (a plain `.ts` hook included) the tagger names each state hook by its
  setter as the app runs (`const [open, setOpen] = useState(…)` → "open"), with a statement after the
  declaration on the same line: no hook added or moved, Fast Refresh unchanged. Setting state picks the
  hook by that name, else by its place; a state past a hook whose own hooks can't be counted (one a factory
  makes) can now be set by name. The ledger records each hook's name too.
- The evidence ledger. The tagger's runtime (`LEDGER_RUNTIME`, first in every page it serves, and in every
  page the crawler opens) records each tagged element as React commits it: its URL, its size, its owner
  component's props and the state of each component above it, copied with limits (functions stubbed,
  credential- and personal-looking keys redacted, a cut copy marked). Records are kept in
  `shots/ledger.json` per file and its source hash, so an older version's drop. A dev server started with
  `DSA_LEDGER=<file>` records what a person clicks through, and `shots.ledger` (or `DSA_LEDGER`) adds those.
  A new pass before pass 1 opens each missing element where it rendered and sets the recorded state above
  it, outermost first (only values copied whole); drawings mount with the recorded props, and such a
  drawing is marked `source: "isolated"` in the shot index.

### Fixed

- Drawings from the app's code get the app's own providers first: those above the element's file on the
  page, else what the entry file wraps the app in. Every context the page provides (an open panel's, a
  deep page's) is borrowed only when that fails or doesn't show the element: one of those can hide it.
  Elements no route names are drawn on the home page, not the first page visited.
- A root's nav values are also read from the files it imports: its state's type alias (or enum), and a
  registry whose field it passes to its setter (`setView(n.id)`). The log lists the values found.
- Pass 2 (exploring) stops after 8 pages in a row find nothing, and the log ends with the time each pass took.
- Photos carry the run that took them: `shots/index.json` has `run: { id, ref, at }` (the source commit, or
  "worktree" when a tracked file's content changed), and each new photo its `run` id beside its `at` time.
  It reads git without writing: plumbing `diff-index` with each file checked by content, never `git status`
  or `git diff`, which rewrite the index of a checkout dsa may only read. Cached
  photos keep their own, so a report can treat older ones as stale.
- Routes the source doesn't spell out are reached. `apps[name].routeSource` names a module of the app and
  the export that lists every route (an array, or a function that returns one, such as the app's route
  formatter over its registries); it's loaded through the running app's build and its routes go first.
  URLs the app writes itself (pushState, replaceState, a new hash) join the queue, and a URL the page is
  already on is reloaded rather than skipped. `apps[name].profiles` opens a route with local or session
  storage seeded first, no clicking. With more routes known than `shots.maxPages` allows (and no cap
  set), every one is visited.
- One line that renders many nodes: a node that photographs blank, covered or under 2px gives way to the
  next node from the same line (up to four more). An element under 2px on every node, twice, is set aside
  with why instead of being measured on every look.
- An app's own `dsa.config.json` is merged into the run: its `apps` entry (routes, extra routes, flows;
  the host's values win, lists are joined) and the folders its `scan.exclude` names. An `apps` key may be
  the app's folder name or its package name. Screenshots stop with an error naming any `apps` key that
  matches no app, and the apps it found.
- An app outside the scan root: every path compared with a source tag is now named as the tagger names it
  (`<app folder>/<path>`), not relative to the root (`../…`). Openers were matched only by their words,
  state was set on the wrong component, and providers were refused as outside the scan root.
- State is read before it's set: a value that already holds (a default) isn't set again, so it costs no
  reload or look. A value the app undoes (an effect that syncs state from the URL) is logged as reverted.
  A boolean never goes into state that starts as an object, and a typed value nothing reads off is set to
  an object, not `true`.
- A miss behind conditions names the first one that doesn't hold with its state's initial values, not the
  first one listed ("not setupTakeover" when it starts false).
- Setting component state no longer crowds out the route crawl. It ran on every page in pass 1 and set
  the root's state (a nav value, a setup flag) again on each one, though that shows the same thing on
  every page; on a large app pass 1 ran out of time with most pages unvisited. It now runs after pass 1,
  in its own share of the time left (half, taken from exploring), and tries each combination once per run, on the first page
  where all its levels could be set. A combination set in full that finds nothing gets up to 3 more
  pages, ranked by whether they show the missing elements' own files (or files near them): the outermost
  component is often the root, on every page. One whose component isn't on any page tried is set after
  the state that first showed that component's file (a nav value that renders the view it's in), in one
  go, and the log says which. Each miss's line now says which page showed its own file, or that none did.
  When no state set showed it, the root's nav state is set to each value its source names (compared with
  it, passed to its setter, its `switch` cases, its literal type), by itself, to see which views each shows;
  up to 60 values.
- Live photos no longer depend on page order. Traced openers ("Edit Image", "Add") were replayed at most
  40 times per app run, so in a large app the order of pages decided which got replayed. Any change to
  what was still missing could push one past the limit. Now each page gets up to 12 replays,
  openers that reveal the most go first, and an opener matched only by its words on one page is tried
  again on the next page that has it.
- A modal a custom hook renders (`useDetailImages` returning `<ImageEditorModal open={!!editor} />`):
  - The scan follows the hook to the component that calls it, and keeps the conditions where that
    component renders what the hook returned (`{openColour && <section>{modal}</section>}`). Before, it
    kept none.
  - The hook's own state (`editor`) is set where React keeps it: in the calling component, after that
    component's earlier hooks.
  - A condition given as a prop (`open={!!editor}`) is read as its value's condition.
- Apps that navigate by state in their root component, not by routes (`activeNav`, `setupTakeover`): an
  element's conditions are set level by level, outermost first. The root counts as on every page, and each
  component below is set once the level above has drawn it, with a photo after each level. A custom hook's
  own state hooks are counted from its source, so a component that calls one before its `useState` can
  still be set. The page's line says which level didn't show.
- Drawings set state only as a last try, on a fresh drawing, after the traced clicks and the drawing's own
  controls. Setting it first could change a drawing so that clicks which used to reveal an element didn't.
- A `live.apps[name]` entry with only settings (`readPaths`, `readApi`, `auth`, `signIn`) and no `url` or
  `dir` no longer skips the app as "a live surface needs url or dir". Its settings apply to the app dsa
  starts itself, and the log names the reads it allows.
- The same app and setup reach the same elements run after run. After every load, click and state change,
  the crawler waits until the page stops changing and the app's own data requests are back (a request seen
  three times counts as a poll and isn't waited for), instead of a fixed wait. A page's time limit is now
  a rarely reached safety cap (2 minutes, 4 on pages that render what's missing), so its interaction
  budget ends it the same way each time. When a time limit does cut a pass short, the log says so,
  because only then can two runs differ.
- A provider search that finds nothing says what it looked at: the imports it followed from the
  component, where each name was declared or that it wasn't among the app's files, and whether the file
  was outside the scan root.
- Elements behind a component's own state ("when openColour", "mode === 'current'", "not singleView")
  are reached live. On a page that shows the component, the crawler sets that state through React, photographs
  what shows ("after setting openColour = {…}"), then reloads. The value comes from the condition, or is
  shaped by how the component reads it. A drawing does the same before clicking anything. Each page logs
  what it set and what it found ("state on …").
- The log ends with every element not reached live on its own line: why, its conditions and the component
  each is in, and the routes that render its file.
- A page also counts as rendering a missing element when it shows that element's file, or a file that
  imports it within three steps, read off the page's source tags. This holds where the scan can't tie a
  route to its files, and for a modal a child of the page opens. Such pages get twice the interactions and time.
- A page whose route the scan says renders a missing element is explored first, and every control on it
  is tried, whatever was tried on other pages. Each explored page gets a log line: how many interactions,
  how many found, and whether its budget ran out. Opener lines show the page's own route, hash included.
- A provider the page doesn't have is found by following the component's own imports (two levels) and
  then the whole app, with tests and stories last. Before, only the first 6,000 files were read. When the
  hook's file makes a context but no provider component, the mount provides that context itself, with a
  value shaped by what the component reads off the hook. The tagger keeps a file's contexts even when the
  file has no JSX.
- Mounted props: a `Set` or `Map` prop (by its type, or because the body calls `.has(` or `.get(`) gets
  an empty one. A value rendered anywhere (`{open ? lead : null}`, `icon={lead}`) is never an object. An item
  handed to another component in the same file (`<Node node={n} />`) is shaped by how that component reads
  it, and a tree that draws itself ends with an empty list.
- Exploring skipped a control on a page if one with the same words had been tried on another page, so
  the first page to show "Edit Image" decided for every page. Now only the same control (the same source
  line, when tagged) is skipped. The log now has a line per page for the traced openers tried there and what each found.
- Mounted components get better props. A prop typed as a node gets nothing, and a prop rendered as text
  never gets an object. Required props, including ones typed elsewhere, get their shape from how the body reads them,
  nested, and a list gets one item shaped by its row, so helpers called per row draw. A provider the page
  doesn't have ("useX must be used inside XProvider") is found in the source and wrapped around the
  component. Drawings import files the way the app does, so a provider and its hook share one context.
- Drawing is quicker: at most 8 controls clicked per drawing, within 8 seconds, and a traced opener's reset
  loads the page once.
- Drawing from the app's code reaches more elements. An element behind its component's own state (a tab,
  a toggle, a menu) is drawn after the mount clicks what the scan traced, then the drawing's own controls,
  never one that saves, deletes or leaves. One made by a render helper (`cellFor`, `renderBody`) is drawn
  by the component around it. The mount also borrows every provider the live page has, not only the ones
  near the element.
- A component that fails to render says which component threw, the error's first line, and what it needed
  when its source shows it ("the prop invoice", "what useSession reads (a provider above it)").
- A page that shows text but nothing to click, and logs an error, is swept like any other page; only a
  page with no text and nothing to click, or one whose modules mostly failed, counts as not rendered.
- Components didn't mount in an app whose Vite server sets a base path (or whose root is a folder below
  the scan root): the mount asked for the file at a URL that server doesn't serve. The tagger now answers
  `/@dsa/where`, the URL its own server serves a file at (its root and base applied), and the mount imports
  that. When a file still can't load, its line says what the server answered for it, or which of its
  imports failed, instead of "Failed to fetch dynamically imported module".
- Fewer live photos after the sign-in change: every reload while exploring a page waited up to 8 seconds
  for the network to go quiet, which an app that keeps polling never does. Only a route's first visit
  waits now. A page that rendered something to use is swept even when some of its requests failed, and a
  request the browser dropped because the page moved on isn't counted as a failed module.
- An app's `vendor/` folders and what git ignores in its folder aren't treated as its usage, so a synced
  copy of the design system's own tooling no longer makes recommendations. An app folder git ignores as
  a whole is still scanned.
- A drawing that came out with no size is no longer dropped: its line says why (its styles hide it, it's
  empty in its markup, or its styles give it no size), and it's shown outlined at a small size, labelled
  "Outline only" on its card. It doesn't count as seen.
- Only 40 elements per app were drawn, and the rest were dropped with one total line. There's no count cap
  now, only a time budget (10 minutes per app), and each element is drawn on the page of a route that
  renders it without reloading the page for every one.
- Cards showed a proposal with the story's sample content although the element had its own. The
  confidence cap changes which question an element is in, and so what its card proposes, and the last cap
  ran after the last drawing. Now dsa caps and draws until nothing new is wanted
  (`settleProposals`), and wants each card's pick both as the elements stand and with the cap lifted.

- The screenshot crawler reaches elements with no routes or flows written down. It reads the app's routes
  from the source (JSX routes, route objects with element, Component or lazy, React Router's route config,
  Next's file routes) and, with the scan's import graph, opens the routes that render each missing element
  first, densest first. It fills routes like `/orders/:id` from links and clicked table rows on pages it
  has seen, clicks the control the source traced for a state by its source tag, and picks form options
  and ticks boxes to reveal fields, never submitting. Each run reports, per app, what was reached live,
  drawn from the app's code, shown as markup only or not shown, and why the rest weren't reached live; each miss keeps
  its reason.

- Element Review shows every element the best way it can, under three labels. "Live app screenshot": a
  photo, or one taken again with a covering layer hidden (a toast, a sticky bar; up to three, then put
  back). "Drawn from the app's code": for an element the crawler can't reach, its component mounted
  through the app's own Vite dev server (apps dsa starts), with props that meet its traced conditions.
  It counts as seeing the element when it was found by its exact source tag and isn't blank, because it
  runs the real component with the real styles; it never feeds placement and the element stays "not found
  live". "Markup only": its own JSX as static markup with the app's styles, shown but never counted. The
  trust rubric reports each source (`sources`: live, code, markup, none). `shots.draw: false` turns
  drawings off.

- Source tags make Element Review's matches exact. `@snds/dsa/tag` stamps every host JSX element with
  `data-dsa-src="<file>:<line>:<col>"`, the place the scanner records (paths relative to the scan root,
  never absolute). It ships as a Vite plugin (`dsaTag`; Vite, React Router v7, Remix on Vite) and a
  Babel plugin (`@snds/dsa/tag/babel`; Next.js through Babel). Both are off unless `DSA_TAG=1` or
  `when: true`. Components stay untagged unless `components` names them. Apps dsa starts itself are
  tagged with no change to their files: Vite through its API, with the app's own config and the tagger
  added inline; anything else with `DSA_TAG=1` (`apps[name].tag: false` turns it off). On a tagged
  page the crawler matches only by tag: the exact line is 100%, with no ties; a `.map()` line is "one of
  N rendered by this line"; a missing line is "not on this page", never a guess. Untagged pages keep the
  heuristic, and each run says how much of each app was tagged. A tagged photo is proof of place for
  the trust rubric (C1, C2) and the confidence cap, and the card says "matched by source tag". SWC isn't
  covered yet.
- Screenshots of signed-in single-page apps that keep their tokens in memory (OIDC with PKCE).
  `live.apps[name].signIn` (`{ "path": "/login", "click": "Sign in with Acme ID" }`) signs in once per
  browser by clicking that button, and comes back through the identity provider without a password
  using the saved session. The crawler then moves inside the app without reloading, so in-memory tokens
  survive. A password form at the provider means the saved sign-in expired, and dsa says so.
  `live.apps[name].readPaths` lists data paths the crawler may read (globs; a full URL for another
  host). The network guard lets the identity provider be read, and posted to at its token endpoint only.
  Every write to the app stays blocked, and what was allowed and blocked is logged by path, never with
  values. `dsa login` also saves the app's session storage, and the crawler puts it back. See
  docs/deploy.md.

- Confidence never outruns the evidence. Nothing reaches Element Review's "ready" band (the review
  threshold, 90% by default) without a visible photo of it in the app (its own, or one of the same look)
  and, for a replacement, the proposal drawn exactly with its own content. Missing either, a
  recommendation is held at 89%, joins a question, and its card says why in plain words ("Held under
  90% (the scanner said 92%): there is no photo of it in the app; …"); when the evidence arrives, the
  scanner's score comes back. Decisions a person or agent recorded are never held. Applied by the scan,
  after screenshots, and after `dsa render` (`applyEvidenceCap`, `capByEvidence`; stored as
  `evidenceCap` on each evaluation, so the CLI, the agent and the dashboard agree).

- Element Review photos and proposals are checked, not assumed. A capture waits for fonts, checks the
  element is the top layer at its centre (`elementFromPoint`) and that its box has painted pixels, and
  tries hover, then focus, before it records the photo as blank or covered; the card then says "Captured
  but blank" instead of showing an empty box. Each photo keeps the element's own content (its words,
  aria-label and icon, sanitised), and `dsa render` draws each proposal with it, instead of the story's
  sample label or a stand-in icon, and says so when it can't. It also draws what each card proposes, the
  auto-picked size included (`autoPick`, now shared by the report and the renderer), and runs again after
  the screenshots' evidence pass. A proposal that can't be drawn says why in plain words and shows the
  component's story as written in its place.
- Ties: identical-looking elements on a page no longer cap a match at 1/ties (that hid most correct
  photos); a tie among different-looking ones still does. Two source lines that want the same controls
  count each other as ties and are a guess between them, unless the page's route names one. Cached
  "not found" results are tried again when the app's setup changes (its start, routes, flows, live
  surface, sign-in, or built folder), without `--retry-missing`.

- Screenshots find React Router's config routes: `app/routes.ts` built with `route()`, `index()`,
  `layout()` and `prefix()` from `@react-router/dev/routes` is read (nested routes, optional segments).
  Routes with a `:param` or a splat need a value, so they aren't guessed; `dsa shots` lists them, to name
  real ones in `apps["name"].routes`.
- A sign-in wall reads as one. When every page sends the crawler to a sign-in (a login path, another host
  such as an identity provider, a password form), `dsa shots` says "Every page asked for sign-in. Run
  `dsa login <url>` and set live.apps["name"].auth", stops early, and remembers no misses for that app,
  instead of reporting hundreds of elements "not found".

- Element Review cards show their evidence plainly. Each photo is labelled "In the app" with its app,
  a file:line that opens the code, and the match; the proposal beside it is labelled "Proposed" with
  the component and its props, or "Closest variant" (with why) when the exact props aren't rendered.
  Photo and proposal are drawn at one CSS scale (both are captured at 2x), the photo cropped to the
  element; a wide one such as a table keeps its size and scrolls. A split card shows each part's own
  proposal. With one app chosen, a question that covers several apps shows that app's evidence and says
  what else the answer covers, and a question is listed under every app it holds an element of. Reasons
  and "how" lines are in plain words on the card (`plainText`), the scanner's own words under Technical
  details. The zoom view no longer doubles "after opening", and proposes what the card proposes.
- The trust rubric (`packages/dashboard/src/trust.ts`): ten checks a recommendation must pass on its card
  before a person can approve it with confidence, scored from a report. `scripts/review-demo.mjs` builds a
  review with real photos and renders from the acme fixture plus `test/fixtures/review-demo`, and
  `--score` prints the rubric for it.

- One app selector for the whole dashboard, in the header beside "Ask the agent": "All apps", or
  one consumer app or child library, and every view shows that app's numbers. Overview's cards (with
  "Majors behind" in place of the all-apps version share), Do now / Decide and open count; Actions'
  list, scope tiles, counts and "Create issues"; System's uses, overrides and look-alikes; the Apps
  table and cards; Trends' lines; Readiness; and Element Review, which loses its own selector (all
  apps lists every app's elements together, since one question can cover several apps). The choice
  rides in the address bar after the route (`#queue/F-1/details?app=billing`), so reloads, Back and
  shared links keep it, and links without it open on all apps. It filters on the page, so a
  published snapshot works too. Where a number covers every app (the scan's confidence, the agent
  prompt, bench runs, Figma and system usage), the view says it isn't split by app yet. The report
  now carries the per-app numbers this needs: each component's uses and look-alikes by app, each
  run's measures by app, and the model's app uses by app. Hidden when the scan measured one app.

- `dsa checklist`: a design-system health checklist with agent readiness built in
  ([docs/checklist.md](docs/checklist.md)). It has 78 items in 13 areas. The scan measures 52 of
  them from the same reading as `dsa scan`: tokens by tier, group and mode, component kinds, variant
  axes and anatomy, docs, story and test coverage by component, adoption and correct use, the ratchet,
  and agent artifacts (component manifests, DTCG tokens, llms.txt, AGENTS.md and editor rules,
  SKILL.md, an MCP server package or `profile.agent.mcpServer`, MCP configs, lint guard rails, evals).
  Every measured item carries its evidence. The team answers the rest, or overrides the scan, in
  `dsa.checklist.json` (schema `schema/checklist-answers.json`). An override keeps what the scan
  found. Areas score done plus half of partial over the items that apply; unanswered items are listed,
  not scored. `--markdown` writes a page to share. In a repo with no system source, the system-side
  items are left to the team instead of marked missing.

- Evidence as data, with a code reader. Findings now carry the places they cite (file, line, target
  and what's there, up to 25; stored in a new `places` column, migrated in place), and older findings
  read their "Examples:" text back into places. An action shows its evidence sentence and "N places"
  folded; open, one row per place (the checkout folder stripped, vendored code marked), and each
  opens a code reader: the lines around it, highlighted, the line marked, prev/next (arrows or J/K),
  Copy path:line, and Open on GitHub at the scanned commit. A published page carries the excerpts,
  captured at scan time and capped (12 lines either side, long lines cut, a total budget); `dsa
  serve` reads the file. Reads stay inside the scanned targets and never show environment files,
  keys, credentials or dsa's data folder. System's "Declared in" and Element Review's code viewer use
  the same reader.

- The scan relay ([docs/relay.md](docs/relay.md)): a published dashboard re-scans without the viewer
  handling a token. One Web Fetch handler (`@snds/dsa/relay`) holds the runner credential as an
  environment secret, signs viewers in with GitHub's OAuth web flow (no scopes; access to the repo is
  checked with the relay's own token at sign-in and before every scan, default write), and gives them
  a short-lived signed session (HttpOnly cookie, and a bearer token in the tab's sessionStorage for
  browsers that block third-party cookies). Starting a scan needs the dashboard's origin and the
  `X-DSA-Relay` header; CORS answers only that origin. One scan at a time (a second press follows the
  running one), a per-viewer rate limit, and progress read from the run and its steps on the server.
  Runs in `dsa serve` (when `DSA_RELAY_*` is set), alone with `dsa relay`, or on Cloudflare Workers,
  Netlify or Vercel (`examples/relay/`). `dsa publish --relay <url>` or `host.relay.url` points the
  page at it.
- Re-scan from the page, with progress. Runners share one contract (`trigger`, `status`,
  `listActive`): GitHub (`workflow_dispatch`, through the scan relay), a webhook with status URLs,
  and `dsa serve` (scans now run as a background job). Every scan (started here, or found running on load,
  scheduled ones included) takes over the page: the page behind is dimmed, blurred and inert, and a
  card shows the estimate, elapsed time, and a filling bar with the steps when the runner reports
  them (a sliding bar when it doesn't; still for reduced motion). "Run in the background" leaves a
  pill in the header that reopens it. Under the heading ("Scanning…"), one line says how many steps
  are left; the logs link shows only when a scan fails ("View logs"). It ends on the new report (loaded by itself) or on the
  reason the scan failed, with Try again and a link to the run.
- The next scheduled scan, in the header and under Re-scan: `host.schedule` (cron, UTC), or read
  from the GitHub workflow's `on.schedule`.

### Removed

- Pasting a GitHub token into the published page to re-scan. Re-scan goes through the scan relay;
  without one, the page says how to enable it. `host.github.dispatch` is ignored.

### Fixed

- An app that doesn't render no longer reads as hundreds of elements "not found". When every page
  stays blank (no text and nothing to use, or it threw), or the app's own module requests mostly fail (a
  dev server answering 500 for a package that isn't installed), `dsa shots` says "The app didn't render:
  <its first error>. Fix the app's install, then run again.", stops early, and remembers no misses for
  it. A page that renders but logs an error is fine.
- Fixing an app's dependencies retries its misses without `--retry-missing`: the app's lockfile and its
  `node_modules` install marker (`.package-lock.json`, pnpm's `.modules.yaml`, yarn's state file), from
  the app's folder up to the root, are part of the setup a miss is remembered with.
- `dsa login` no longer makes signing in impossible: it saved the session every 1.5 s, which in a visible
  browser took focus from the sign-in form. It now saves once a page has loaded and gone quiet (2 s),
  and once at the end; never on a timer. IndexedDB is left out of the saved session unless `--indexeddb`.
- The review demo's built pages are kept in git (`site/`; `dist/` is ignored).
- Overview's "Used as intended", "Apps on a current version" and "Tokens in new code" cards opened
  Trends instead of Apps.

- Dialog footers run edge to edge whatever a dialog's padding: content and footer share one padding
  variable (`--dialog-pad`), and a test refuses `p-*` on a dialog.
- Buttons and fields share one height scale (`--spacing-control-sm`, `--spacing-control`,
  `--spacing-control-lg`): Button, icon buttons, the agent split button (both halves), inputs, selects
  and toggles. A row sets its size once (`ControlSize`) and every control in it follows, so the split
  button no longer sits shorter, with smaller text, than the buttons beside it. Disabled buttons are
  easier to read (60% opacity, was 50%).
- Overview stat cards: the change chip (arrow, value, "pts") no longer wraps. It sits in a slot of
  fixed bounds, so the "vs scan of…" text starts at the same place on every card; only that text
  wraps, and on a narrow card it drops below the chip. "No change" has a neutral arrow, and a fall
  reads "−0.4 pts" with a true minus.
- A design system read from another checkout can span several folders: `system.sources` (and a
  child's `sources`) now reach the engine, not only the system model, and accept globs of package
  folders (`../vendor/ds/packages/*`), so its tokens package is read too. With `git`, sources are
  folders inside the clone. A source folder without a `package.json` no longer stops signatures.
- Overview deltas: a value the earlier scan didn't measure reads "First measurement", an unchanged
  one "No change" (never "NaN pts" or "−0 pts"); Trends leave a gap instead of plotting NaN.

- Running where the product is deployed ([docs/deploy.md](docs/deploy.md)). Three new config
  sections, each picking an adapter by name behind interfaces in `src/deploy/` (the core names no
  hosting service; add-ons add adapters with `hosts` and `histories`):
  - `live`: the live revision (a config value, a version endpoint on the live site, CI variables
    outside pull-request builds, or a host adapter's deployments) and where to see the product (a
    deployed `url` with a saved sign-in from `dsa login`, or the built `dir` that ships, served on
    localhost). `dsa run`, `shots`, `render` and the dashboard's Run button refuse a checkout that
    isn't the live revision, or run labelled with `--allow-unreleased` / `onMismatch: "label"`. Each
    run records the check; the dashboard shows the scanned revision and when it went live, and a red
    banner when it isn't live. `dsa live` runs the check alone.
  - `host`: `dsa serve --host --base /dsa/ --allow-host` mounts the live dashboard under a sub-path
    behind a proxy. A published page's Re-scan and decisions go through the host adapter: `generic`
    (a link or webhook; a downloaded file or a POST) or `github` (the scan workflow's
    `workflow_dispatch` page; decisions filed as a labelled issue that a workflow applies, committing
    or opening a pull request). `dsa apply-decisions --file | --url | --issue [--close]` applies them.
  - `history`: the data folder persists between runs through `local` (default), `git-branch` (a
    branch of the measured repo, through a throwaway index) or `command` (your own pull and push
    commands, for an object store). Secrets and saved sign-ins are never persisted.
    `dsa history pull | push` for separate jobs.
- Screenshots resolve routes under the app's mount path (`https://example.com/app/` + `/orders`).

- Name-free archetypes (`data/archetypes.json`) for twelve core kinds: button, text
  input, checkbox, select, dialog, tabs, card, alert, badge or tag, tooltip, menu, table.
  Each holds preferred and alternative names, false friends, native elements, ARIA
  roles, parts with their aliases, states, and the variant vocabulary (emphasis, tone,
  size, shape, orientation) with value synonyms.
- Concepts are typed against them (`concept.kind`: kind, confidence, runner-up,
  ambiguous, evidence) by name (word by word), parts and variants. Sub-components,
  exported constants and false-friend matches are handled; with no name signal,
  structure must be strong on its own.


### Added

- Tokens in the system model: CSS custom properties (with the mode a selector or
  `prefers-color-scheme` sets), top-level Sass variables and Sass maps (`$map.key.sub`),
  and DTCG / Style Dictionary JSON (`{a.b}` aliases), from the system's sources and the
  package's built CSS; for a copy-in system with none, the app's global stylesheet.
  Each token has a group (from its name, or its DTCG type or value), an alias, and a
  tier from the alias graph (literal = primitive, alias = semantic, a component's name =
  component). Concepts carry the tokens their own styles reference (`var(--x)`, `$x`,
  including Lit `css` in sibling `*.styles.ts`). `dsa model` prints the token summary.

- Facets on every concept in the system model: **variant axes** (a prop or class
  family and the closed set of values it picks from) and **parts** (named pieces of
  its anatomy), each with evidence. Axes come from TypeScript string-literal unions
  (type aliases resolved across the system, including `typeof X[number]` and
  semicolon-free code), Lit/Angular class properties and `input<…>()`, Vue
  `PropType<…>`, `PropTypes.oneOf`, cva/tailwind-variants recipes (also in Svelte and
  Vue script blocks), spread prop factories followed through imports and `@/` aliases,
  and stylesheet modifier classes. Parts come from sub-components, `Object.assign`
  members, `data-slot`/`data-part`/`data-component`, `part="…"`, `@csspart`/`@slot`,
  `<Name>Classes` and `<Name>Slots` types, BEM elements including nested Sass
  (`&__title`), and template macros' object parameters. A family of sub-components with
  no declared parent implies it. Type-only exports are no longer concepts.


### Changed

- One dashboard for every role: the "View as" picker is gone (and what it stored is forgotten).
  Every view leads with the highlights, and more is one click away through one control: "Details"
  for the supporting data and guidance, "Technical details" for paths, lines, IDs, raw text and
  config. Actions: who, why, who acts and when it's done up front; evidence, history, repo, markup,
  the item ID and the file command under Technical details (linkable as `#queue/<id>/details`).
  System: six columns; each component opens its variants, parts, tokens and declaring file
  (`#system/<filter>/<key>`). Element Review and Settings use the same control.

- `scan`, `ratchet` and `run` read through the system model, so they measure every
  framework and markup the model reads (Vue, Angular templates incl. inline `template:`,
  Svelte, Lit, HTML, Nunjucks, CSS classes), not only React imports. Counts can change:
  run `dsa ratchet --update` once after upgrading. The React graph is now built only
  when `patterns` needs it, so `scan` and `ratchet` are much faster on large repos.
- The model reads the core and every `system.children` library, credits each use to its
  library, and treats a child using the core as consumption. It finds a library's source
  from `system.path`, workspaces, any `package.json` by name, local aliases, or the
  installed package in `node_modules`; an import from a library or a tag with its
  configured prefix counts even when no declaration was found.
- Elements passed as a prop's value (`icon={<Icon />}`) are never raw elements, in any
  language the model reads.

### Added

- `dsa model`: the system model. Concepts from how a system declares itself (package
  exports, web-component registration, Angular selectors, Vue components, template
  macros, stylesheet class blocks and built CSS), every form each is written in, and
  every use across JSX, Lit templates, Vue, Svelte, Angular templates, HTML, Markdown,
  MDX, Astro and Nunjucks, each with evidence. Host elements with a system marker are
  uses, not raw elements; dotted members are parts; class-only concepts in systems
  that declare components otherwise are style objects. `src/model/`, `test/model.test.ts`.

### Fixed

- One bad input no longer ends a run. A file its reader can't read is skipped and
  listed (`note: skipped N files`), a pnpm lockfile holding several YAML documents
  is read in full, an unreadable lockfile costs only the version rows, and a
  `<table>` from a reader that collects no table facts (Angular, Vue templates) is
  still classified. Found running dsa on ten open-source design systems.

## [0.3.1] - 2026-10-29

### Fixed

- Signatures follow a cva wrapped in a function declaration
  (`function buttonVariants(p) { return cn(variants(p)) }`), not only in an arrow
  function, so such a component's variants and sizes are read.

## [0.3.0] - 2026-10-29

Every feature of the earlier analytics suite now lives here (Phases 2–4), and the
add-ons can be installed outside this repo.

### Releases

- Releases: one version for the core and every add-on. Pushing a tag `vX.Y.Z`
  tests, packs, installs the tarballs into a fresh project and attaches them to a
  GitHub Release (`.github/workflows/release.yml`, `pnpm release:pack`,
  `pnpm release:smoke`). CI runs the pack and the install on every pull request.

- Add-ons name the core and each other as peer dependencies (`workspace:^`), so a
  consumer installs the release tarballs with no overrides. `@snds/dsa-agent`'s
  dashboard and review are peers now, not dependencies.
- `dsa mcp` reports the package's version instead of a fixed `0.1.0`.

### Fixed after the Unicron QA review

- Component signatures read components in subfolders of `src/` that the package's
  `src/index` re-exports (a shadcn layout keeps them in `src/components/ui/`).
  Files directly in `src/` are read as before; a deeper component never replaces
  one found there.
- An element passed as a component's `render` prop (`<Item render={<button />}>`)
  is the element that component draws as, not a raw look-alike. Content passed to
  other props (`action={<button>…</button>}`) still counts.
- A screenshot match tied with other elements on the page is as sure as a guess
  among them (at most 1 in N), so its placement no longer feeds the next
  evaluation.
- The report, dashboard, queue prompt and agent brief fall back to the system's
  name before the folder's.


### Added

- CI name check: `scripts/name-check.mjs` fails when a tracked file matches the
  `DSA_NAME_DENYLIST` pattern. In CI the pattern is a repository secret; it is
  required on pushes to `main` and skipped where secrets can't be read.
- Profiles: `defineProfile`, `loadProfile` and `resolveProfile`. A profile holds
  what one design system knows that config can't say (component list, role
  offers, its own tooling files, lab pages, an agent-readiness provider, its name
  in report wording). It lives in that system's repo; dsa ships a neutral
  default. Not yet read by any command; the config gains `profile` next.
- Source adapters: `buildGraph` takes `adapters`, readers for other markup
  languages that claim file extensions. React is the built-in `reactAdapter` and
  still reads every file no adapter claims. `FileGraph` gains `framework`.
- A pnpm workspace for optional add-ons under `packages/`, and
  `docs/architecture.md`.
- Config `profile`: the system's profile module, by path or package name.
  `loadRunContext` loads it and every run carries `ctx.profile`; the CLI runs
  through it. `createRunContext` takes `options.profile` and refuses a config
  that names a profile it can't import.
- Config sections for features still landing, in the schema now so configs can
  carry them: `system.children` and the core's `tagPrefixes` / `mainRef`; where
  code lives (`path`, `git`, `aliases`, `exclude`, `pin`, `owner`, `repo`);
  `consumers`, `extraRepos`, `internalConsumers`; `correctUse.elementMap`,
  `nativeLookalikes`, `exceptionsFile`, `deprecated`; `tokens`, `tailwind`,
  `apps`, `review`, `rendered`, `shots`, `modules`, `figma`, `github`,
  `agents`, `report`, `settings`. None has a default, so existing configs parse
  and report exactly as before.
- `dsa config migrate`: converts an analytics-suite config, listing every key
  that moved or was left out. Library: `migrateSuiteConfig`, `isSuiteConfig`.
- Exports `loadRunContext`, `scanFromContext`, `patternsFromContext`,
  `ratchetFromContext`.
- `dsa run`: the earlier analytics suite's engine, ported. It reads the repo's
  workspaces and other repos (a local folder, or a git URL it clones and only
  reads), package versions and pins, component use (React, Vue single-file
  components, Angular templates), native look-alikes, token compliance and
  Tailwind drift. It computes the catalog's metrics (`data/metric-catalog.yaml`),
  raises findings that open, update, hold and resolve across runs, and writes an
  issue draft for each open one.
- Element review: every native look-alike gets a recommendation, a confidence
  and its evidence, read from its classes, children and context and matched
  against the core's component signatures. Decisions are kept in each app's
  decisions file and calibrate later runs.
- Commands: `where`, `init`, `run`, `reevaluate`, `findings`, `issues draft`,
  `issues sync`, `snooze`, `settings`, `settings set`, `elements`,
  `signatures`, `explain`, `decide`, `plan`. Global options `--root`, `--data`,
  `--profile`.
- `@snds/dsa-history` (`packages/history`): run history in DuckDB. `dsa run` and
  the history commands use it when it is installed, and say what to install
  when it isn't.
- Add-ons: `defineAddon({ name, store, stages, commands })`. The CLI finds
  installed `@snds/dsa-*` packages and lets them add commands, `dsa run` stages
  and the history store.
- Profile fields for the element review: `icons`, `buttonTokens`,
  `controlHeights`, `navTokens`, `containers`, `metrics`; a role offer's
  `verdict`; and a readiness provider's `isSystemRepo`, `setupHint`,
  `missingNote` and extra metric rows. Every system-specific value the suite
  knew is behind these; dsa ships neutral defaults.
- `scripts/parity/`: runs the suite and dsa on one repo and checks they store
  the same data.
- Dependencies: `@babel/parser`, `@vue/compiler-sfc`, `htmlparser2`, `semver`,
  `yaml` (all plain JavaScript).

- Phase 3 add-ons, each adding its commands to the one CLI:
  - `@snds/dsa-dashboard`: `serve` (port 4319), `report`, `publish`, the action
    queue, and the React dashboard (its build ships in the package).
  - `@snds/dsa-review`: `shots`, `render`, `setup`, scripted flows, the
    Storybook preview proxy, and `run --shots` / `--no-shots`.
  - `@snds/dsa-figma`: the Figma crawl as a `dsa run` stage, and
    `run --figma` / `--no-figma`.
  - `@snds/dsa-agent`: `mcp`, `agent brief`, and the dashboard's agent
    workbench (sessions in a sandbox, proposals, before/after pictures).
- Add-on API: `afterRun` hooks (screenshots, the report, the agent snapshot run
  after `run` and `reevaluate`) and `routes` the dashboard mounts. Commands get
  `context`, `addons` and `requireStore`.
- `@snds/dsa/engine`: the engine's modules, for add-ons.
- Profile fields for add-ons: `usage`, `iconFont`, `agent` (docs, MCP server,
  checker, sandbox links), and a readiness provider's `usageMetric`,
  `reconcile` and `benchRuns`.
- Rendered comparison and fit scores (`compareRendered`, `computeFit`) are in
  the core, so the report needs no browser.
- `scripts/parity/` also compares the report, the published site, issue drafts,
  the review queue and screenshot manifests (`--shots`).

### Changed

- A config written for the analytics suite is converted in memory when it is
  loaded, instead of parsing as an empty dsa config.
- README provenance and NOTICE: dsa now absorbs the author's earlier analytics
  suite, which he owns.

## [0.2.0] - 2026-10-17

### Added

- `rawElements`, a fifth correct-use count: plain HTML controls written in a
  consumer where a design-system control belongs (`<button>` by default;
  `correctUse.rawElements` in the config lists the tags). An element handed to
  a component through a prop (`render={<button />}`) isn't counted. The scan
  report lists each one with its location, and the ratchet fails when the
  count grows. Raised from Mailbird's raw-button sweep (its ADR-0057), where
  44 plain `<button>`s were invisible to the other checks.
- The ratchet report's `untracked`: metrics the baseline doesn't have yet
  (added by a newer dsa). They're shown and not compared, so upgrading dsa
  never fails CI on its own; `--update` starts ratcheting them.

## [0.1.0] - 2026-10-15

### Added

- Composition graph built with ts-morph: one tree per JSX root, element kind
  (`ds` / `local` / `html` / `external`) resolved from import declarations and
  `dsa.config.json`, literal shape props, file/line/column, override and spread
  flags, declared local components with their render roots.
- `dsa scan`: component inventory, adoption counts (definition 1: imports and
  instances) per file, directory and total, custom ratio, and correct-use
  findings (className/style overrides on DS components, spread props on DS
  components, local look-alikes of DS names).
- `dsa patterns`: pattern-candidate detection. Canonical anatomy hashing,
  occurrence counting across hosts, the 3+ occurrences / 2+ hosts rule, the
  tier heuristic (pattern · compound-component · variant · snowflake),
  candidate naming by intent, nearest-existing matching against the framework
  pattern catalog and already-named local components, `--all` for snowflakes,
  `--ignore <id>` with parking after three ignores.
- `dsa ratchet`: freezes correct-use violation counts in a baseline and fails
  CI when any count grows; `--init` and `--update`.
- `--json` on every command; JSON reports in `output.dir` otherwise.
- Public API: `scan`, `patterns` / `detectPatterns`, `ratchet`, `buildGraph`,
  the zod schemas and all report types.
- Data files: the seven-pattern catalog and the 62-component → family map
  from the component and pattern framework.
- JSON Schema files generated from zod for the config, the scan report, the
  patterns report, the suggestion record and the ratchet report.
