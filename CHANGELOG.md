# Changelog

All notable changes to `@snds/dsa` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Element Review by component, its new default view in `dsa serve`. A rail lists where places go (each
  component, then no home yet, keep native and unclear), with how many are left and a progress bar. The
  selected one shows a batch per set of settings and, inside each, places that share a style, so places
  that almost always get the same answer sit together. Every place shows the element as the app draws it
  beside the proposal, at real size, with its page, its code and its status. Answer one place, a look group
  or a whole batch. A batch answer covers only places with a photo and a drawn proposal, never blind ones.
  An answer moves a place to the component it now goes to. "By question" keeps the earlier cards, and
  stays the default on a published snapshot, where decisions are staged.
- One answer, saved once and used twice. In `dsa serve`, a decision made in Element Review is also saved
  as a label for `dsa bench`, one per element it covered. An answer given in Label Review is also recorded
  as that element's decision, so Element Review doesn't ask it again. Each label now says how it was given
  (`how`: `alone`, `batch` or `spot-check`), carries the shared `judgment` id when one answer covered
  several elements, and records what dsa `proposed` and how sure it was at that moment. Element Review
  sends the reviewer's name with each decision, so its labels say who gave them.
- Re-scan is a split button. Its menu sets what the scan does with earlier photos: keep them, retake them
  all, or try again for the ones not found. The setting stays until changed, and shows under the button when
  it isn't the default. It reaches `dsa serve` and the scan relay directly. A published page with a plain link
  to GitHub also shows a `gh workflow run` command that carries the setting, with a Copy button. `dsa run --shots-mode <normal|fresh|retry-missing>`
  does the same from the command line, and a GitHub scan workflow takes it as a `shots` input.
- Label Review: dsa's "ready" answers checked by people, one element at a time, written for a designer
  who never needs to read code. Each item shows the element as the app draws it beside the proposal drawn
  with the element's own words, both at their real size; where it sits on the page, named in plain words;
  why dsa thinks so, in plain words (the scanner's own words and the code sit behind "Technical details");
  where the app already uses the proposed component and props, and the main alternative; and the
  alternatives dsa considered, drawn. One click answers Right, Wrong (then the right answer from the
  system's allowed components and props only, drawn when a render exists, or "keep it" / "nothing fits")
  or Not sure, with an optional comment. Answers are labels.jsonl rows with method "human": `dsa serve`
  saves them to `<data>/labels/human.jsonl` (`POST /api/labels`, schema-checked); a published page keeps
  them in the browser to download. The reviewer is the scan relay sign-in when there is one, else a name
  entered once. The queue is every element a person can decide now (one rule, `canDecideNow`, shared
  with Element Review's "Need a decision" count, so the two agree), then `<data>/review-queue.jsonl`
  (from `dsa labels queue`) when present, else a seeded 10% audit of the ready cards. Keyboard-operable, with screen-reader labels and no colour-only
  meaning; checked with axe in light and dark.
- Element Review: a "Needs evidence" filter beside "Needs you". "Needs you" now counts only cards a
  person can decide now, so it matches "Need a decision". What each card is missing is said plainly and
  grouped with a count ("12 aren't reached yet: they only show after steps in a flow, such as opening
  …"); the code conditions sit behind "Technical details". A control's words read from the code show the
  values the code fills in as "…" ("Message on …: Open request …"), not as stray punctuation.
- Label Review: where the app already uses a proposal is read from the source (`findUses`), following
  local re-exports and vendored packages, across lines, and matched on the system's axes (not
  `type="button"`). With no exact use it shows the nearest, labelled ("Not at this size, but here's the same
  variant at sm"), then the system's own example. "Doesn't use" is said only when every file was read.
- Differences on Label Review are said as what you'd see: sizes, "uses a density setting", "a different
  hover colour"; raw values sit in Technical details, with building instructions. On another surface than
  white, background differences are left out (shots record each element's `surface`).
- Proposals drawn from source find a Storybook beside the packages (`apps/*/.storybook`), load its
  stylesheets and Vite setup (`viteFinal`, Tailwind), and still draw when a decorator only works inside
  Storybook. A drawing the system's styles didn't reach is `unstyled`: tried from stories, and otherwise
  it needs evidence.
- Proposals carry what an element holds besides its words: a shape made of borders, a swatch, a picture, an
  icon-font glyph, separate blocks of text. A photo records a copy (`content.inner`: only what paints or
  lays it out), the drawing holds it, and each mark is checked there. If it can't be shown, the element
  needs evidence ("the proposal doesn't show this element's inner content"). Photos from before this are
  taken again once.
- The report page now gets each drawing's recorded words and each photo's words, so "with its own words"
  is checked on real runs, not only in tests.
- `dsa render` always logs how many drawings the system's styles missed and how many lack their element's
  inner content, zero included, naming the elements; and how many couldn't be drawn from source, with the
  first reason.
- The dashboard header says when the photos and drawings were taken, beside the last scan.
- Label Review leaves height and width out of the differences for content-sized elements (tables, tiles,
  elements with several text blocks): beside a story's sample content they say nothing.
- CI fails when the committed report UI (`packages/dashboard/templates/ui`) isn't built from `ui/src`.
- `dsa render` draws again a cached proposal drawn with the element's own content that doesn't record
  which words it drew (made before drawings recorded them), or drew other words than the element has now.
- Precedents: where the app already uses each proposed component, from the run's system-component uses
  with their literal props read from the source (`propsAt`), or the engine's own `<data>/precedent.json`
  when a run writes one. A use photographed by the crawler (`shots/index.json` `uses["<file>:<line>"]`)
  shows its photo.
- "In context" on review cards and in Label Review uses the crawler's wider crop of the page around the
  element (a shot's `context: { file, box }`, about 800 × 500 CSS px) when it has one, else the shot.

- `dsa bench --folds <n>` reports held-out precision at the ready bar, with its one-sided 95% lower bound:
  labels split into n folds by a hash of their file, each fold scored apart. With `--fold-site` (one run
  per fold, each calibrated without that fold) it also scores the calibrated side. `dsa labels split`
  writes each fold's training and held-out label files.
- `dsa bench` scores two numbers and never merges them. Presentation: the trust rubric, with the card
  checks read from each published page in a headless browser (`--no-cards` leaves them untested).
  Correctness: dsa's recommendations against `labels.jsonl` ground truth, with abstention (under the
  ready bar) kept apart from error. It reports precision, recall, abstention and error rate; how much
  dsa could claim at 99% precision and from what confidence; a reliability curve in 0.05 bins with its
  expected calibration error (ECE); the one-sided 95% lower bound on precision at the ready bar
  (Clopper-Pearson); and Wilson intervals per app and per picture source. With several `--site`
  folders of the same build it reports repeatability: rubric passes that flip, recommendations that
  flip, the confidence spread, and cards that cross the ready line as the page shows it (and, apart,
  on the scanner's own score). Correctness is scored at the scanner's confidence before the evidence
  cap: the cap is a presentation gate, and scoring correctness on it would merge the two numbers.
- `labels.jsonl`: one label per line, `{id, app, file, line, sourceRef, elementHash, truth: {verdict,
  use, props}, acceptableAlts, labeler, method, at, notes}`, with `method` one of human, migrated,
  history, lint or consensus. `schema/label.json` and a zod validator (`LabelSchema`, `parseLabels`);
  `dsa labels check <file>` validates a file.
- `dsa labels` bootstraps ground truth from code that already answers. `migrated`: each app is copied to
  a work folder with every system component stripped back to the markup it renders (its host tag and the
  classes its variant and size add, its own classes kept, lines unchanged), and each is labelled with
  what was there (components that add no classes of their own, and apps whose look-alikes aren't
  measured, are skipped); scan the copy and bench it. Signatures now keep each variant and size's classes
  (`classes`) for this. `history`: commits that turned a raw element into a system component label the
  raw element at the commit before (a shallow clone says it has no history to read). `queue`: where dsa
  and the labels, two labels, or a second judge's labels disagree, plus a seeded 10% random audit of the
  rest, for people to check; human labels are never queued again. The apps are only read.

- Only this run's screenshots count. The crawler stamps `shots/index.json` with its run
  (`run: { id, ref, at }`, `ref` the source commit or "worktree") and each shot with the run that took
  it and when (`run`, `at`). A shot from an older run taken before this run began, or one with no stamp
  at all, is treated as missing by the confidence cap, the report and the trust rubric, and the card
  says why (`staleShot`). The report carries `elements.freshness`: the run, how many photos were set
  aside, and per app the oldest photo that counts and its age in hours before the run.
- `dsa report --run-dir <dir>` and `dsa publish --run-dir <dir>` score and show one run's own folder
  (its `shots/` and `rendered/`) instead of the shared data folder, so photos from different runs never
  mix.
- Isolated renders count as seeing the element, labelled "Isolated render": an element mounted in the
  app's own build with the props it was recorded with (the shot index's `source: "isolated"`). A drawing
  with guessed props stays a separate source (`guessed`) in the trust rubric.
- Two scan kinds found by their own markup, not their tag (`src/engine/kinds.ts`): a Skeleton (a `<div>`
  or `<span>` with `animate-pulse`, a muted fill and no children, all three required) and a Label (a
  `<label>` with `htmlFor`, or wrapping a text field; never one holding a choice control or a button, which
  is that control's own anatomy, and never one inside a Field component).
- A system can be a folder of components (a shadcn-style `components/ui` inside an app): when the system's
  folder has no `src/`, its signatures are read from the folder itself.
- Recommendations apply hard constraints before ranking (`src/engine/constraints.ts`). An element with
  `aria-pressed`, `aria-current` or a selected state only maps to a component with a prop for it
  (`pressed`, `isActive`, `value`, or a `data-state` it writes). A component with a fixed role can't take
  an element with another one, and a `<button>` component can't hold another control. Signatures now
  record each component's declared props and its primitive's state props (`props`).
- Size is picked by distance in resolved pixels, following the system's tokens to their values, with
  height and width as hard limits. A 20px icon button gets the 24px size, never the 32px one its colours
  happen to match. Tailwind steps the size map doesn't list (`size-5`, `h-[30px]`) read as the nearest
  size and say they are off the scale.
- The classifier abstains: verdict `unclear`, with `unclear` saying why and the best guesses as
  alternatives. It does so when a height doesn't resolve to pixels, when an element sits exactly between
  two sizes, when a state-bearing element's pick can't be checked, when every candidate is ruled out, and
  when two different components score within 0.02.
- An optional TypeScript checker, run with each app's own `tsconfig.json` (`src/engine/typecheck.ts`).
  It resolves what Babel can't read: spreads (`<input {...getInputProps()}>` carrying `type: "file"` is a
  file input, not an `Input`), class constants whose type is a string literal, wrappers' props, and the
  system's prop unions, read at one use of each component, as the only values a recommendation may set.
  A spread or class constant it can't resolve makes the classifier abstain (`unclear`) instead of the old
  5% penalty. It runs only over files with something to resolve, loads the app's own `typescript` first,
  and is skipped with a note when there is no tsconfig or no `typescript`; the old penalty then stays.
- Recommendations learn from the app's own migrations (`src/engine/precedent.ts`). Every system-component
  use in the app is indexed with its props, extra classes, class constant, parents and state. A raw
  element styled by a constant the app already put on a system component, or with the same classes as an
  element a commit turned into one (`git log -p`, bounded), follows that migration as near-truth. A
  system component of the picked kind right beside it lends its size. Otherwise the most similar uses are
  named as evidence, and offered as an alternative when they differ.
- Confidence is measured precision on a label set (`src/engine/labels.ts`). A `labels.jsonl` (one
  labelled element per line: `id`, `app`, `file`, `line`, `sourceRef`, `elementHash`, `truth` with
  `verdict`, `use`, `props`, `acceptableAlts`, `labeler`, `method`, `at`, `notes`) is read from
  `recommend.labels` or `dsa run --labels`. Labels feed `calibrate()`, which never ran before for want of
  decisions, then an isotonic fit maps each decision path's score (rule and verdict) to its measured
  precision, pooled when a path has under 20 labels. "Ready" needs the one-sided 95% lower bound of that
  precision at 0.99 or more, so about 300 clean labels on a path. Without labels nothing changes, and
  each evaluation says its confidence is uncalibrated (`calibration.status`).
- Fit is a gate: a replacement whose signature matches under 40% of the element's look stays under the
  review threshold, and says so.
- An app's machine-readable design-system rules file (`recommend.rules`, e.g.
  `design-system.rules.json`) is read as constraints. `controlScale` (px, a list or a map) rules out
  sizes off the scale; `preferPrimitives` as a map (`{ "button": "Button" }`) makes that the only
  component for that element, and as a list prefers those components; `avoid` rules components out. A
  missing or unreadable file is noted and the run goes on without it.
- A saved calibration file. `dsa run --labels <file> --save-calibration <out>` writes what was fitted
  (rule stats, per-path isotonic fits, the ready cut or none) with the labels' paths, content hashes and
  counts, the engine's version and revision, and a hash of the system's signature set. `--calibration`
  (or `recommend.calibration`) applies it instead of fitting. A file fitted for another system is refused
  unless forced (`--force-calibration`, `recommend.calibrationForce`), and a forced run says so in its notes.
- `recommend` in dsa.config.json: `labels` (path, relative to the config), `rules` (path, relative to
  each app), `typescript` (boolean, default on), `calibration` (path) and `calibrationForce` (boolean).
- The element scanner skips files that aren't product code: tests, stories, examples, demos, fixtures,
  mocks, stubs and docs, reusing the model extractor's list (`NON_PRODUCT`). The run notes how many it
  left out.
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

- Photos from lab, specimen and demo pages no longer pass as how the product uses a component. Product pages are
  opened and shown first, and a lab photo appears only when the product has none of that look, captioned "From a
  lab page, not the product". They don't use up a look's photos, and `review.photos.labOnly` counts them apart from
  `sameLook`. Told from words in the file path or address; `shots.notProduct` adds to them or turns this off.
- A normal rerun on unchanged code now gives the same review as the run before it. Drawings count on a
  rerun as photos do (they were dropped because they have no page position to check). A photo the last run
  set aside as old stays set aside, so it can't change the queue. Rendered evidence counts once, not once more
  each run.
- The pass over the app's own uses remembers the pages it has looked at, so a rerun opens only pages nobody has
  opened. When none are left, what it couldn't find stands and the app isn't started for it. A new use, a changed
  file, a changed setup, `--fresh` or `--retry-missing` opens every page again.
- Review cards show the look they propose far more often. The photo pass matched looks by a different rule from
  the cards, so `variant="link"` never matched a card's `variant link, size default`, and `disabled={busy}` made
  a use's look "unknown". It also walked pages by how many files they held, and a limit per component let any
  look use up a component's photos. Both now share one rule (the system's axes with defaults filled in), pages
  are chosen by how many cards they can help, nearest the use's own line, and a look a card asks for has no
  component limit. Any other look gets one photo, and the same look on one page gets one.
- `elements.review.photos` and the log now count cards with a photo in the same look, cards with only another
  look, cards with none, and how many different photos they use. Cards vary their photos: least shown first,
  other pages before a repeat.
- A photo of another look says what it is. The heading speaks for every tile under it. With no real axis in
  common (two looks both at the default size don't count), a card shows one tile, as how the app uses that
  component elsewhere. Variants read "the dark variant", not "in dark", which read as dark mode. Cards no
  longer advise taking the screenshots again when that wouldn't help.
- A rerun on unchanged code no longer empties the review. Every run stamped a new id, so a photo it kept was
  called "from an older run", and with nothing to capture no element kept a photo. A photo this run checks and
  keeps now counts as this run's, with its own age. A photo it didn't check still doesn't count.
- Review cards show photos of how the app already uses the proposed component. The crawler looked for the
  scan's list of uses, which doesn't follow a local file that re-exports the system, so it photographed almost
  none of them. It now looks for the uses the report counts, wherever it goes, then for up to 5 minutes more
  where the ledger saw their files render. A few of each look are kept, and stand while their file is
  unchanged. A card shows only its own app's uses, says how a different look differs, and with no photo says why.
- A word a little past its element's edge still shows whole in the picture, so it's no longer cut off. A
  drawing held narrow by a wrapper now draws at the element's width, so its words show.
- A component that fills its container is no longer judged by the page it was drawn on. It's drawn at the
  width of each element it's for (the nearest one is shown), so a field 161 px wide compares with a field about
  161 px wide. Its width from the container no longer counts toward "a whole proposed for one small part": a
  real whole, like a sidebar for its trigger, is still caught. A whole structure, like a table, keeps its room.
- A drawing at an element's width widens as far as its words need, and the card says so. Words are checked
  where they're drawn, not as recorded: a drawing whose words are still cut off, or don't show at all, is held
  out with a plain reason.
- "What else dsa considered" says when an alternative is only an example, and leaves out one with nothing in it.
- A photo that shows nothing is no longer also called a small part of anything. One only a few pixels across
  says the capture found nothing usable.
- Pictures wider than the card shrink to fit and say so, instead of giving the page a sideways scroll.
- "Where the app already uses" shows photos only. With none, it says so in one line. A control drawn with no
  words is no longer offered as the system's own example.
- A whole structure (rows, a list, tabs, a menu) is no longer drawn with one line of joined words or one icon in it,
  which passed as the element's own because the words matched. It is shown as its story wrote it, labelled as an
  example of the component and not this element's content.
- A field's value and placeholder are recorded with its photo, drawn in the proposal and counted in the word check.
  A password's value is never recorded. A photo from before this needs taking again, and says so.
- The review gate no longer lets a container through with a story's sample in it. Only a drawing labelled as an
  example is exempt from the own-words check.
- One small part proposed as the whole it belongs to is compared with that part when it's drawn, and otherwise held
  out with a reason. "With its own words" is only said when there are words.
- A drawing of a trigger no longer hangs. The harness mounted it inside its own open popup, and now mounts it beside
  what it opens, closed.
- Copies of what an element holds keep what sits on top of what (a marker over a swatch), and pictures are kept at
  about twice their size, so they fit. Photos with a copy are taken again once.
- Every drawing is looked at again on the next render, once.

- `dsa render` can no longer hang on a page that never returns. Each drawing has a time limit (`rendered.drawSeconds`,
  default 30; the first on a page gets five times as long). A drawing past it is stopped, recorded as not drawn
  with a plain reason, and named in the render log with its key and component. The page is replaced, or the
  browser restarted if the page won't close, and the run carries on. Rendered signatures get the same limit.
- A render saves its proposals every 10 items, after a stopped drawing and if it fails, so a killed run keeps
  its finished drawings and a rerun reuses them. Saves are whole or not at all.
- A drawing whose inner content has bare words at its top level is no longer rejected as "could not be looked at".
- Drawing proposals from source no longer breaks partway through a run. When Vite found a dependency late it
  rebuilt its bundle, and with the page open that loaded a second copy of React, so components imported
  afterward failed with "Cannot read properties of null (reading 'useRef')". Vite now reads every component
  before serving, and a page that hits this reloads and draws again.
- A failed source drawing no longer replaces a story drawing that lost its inner content or the system's
  styles. The drawing stays, and it still needs evidence.
- Failed drawings are tried again on the next run instead of being cached. Only a component that isn't in
  the system's source stays cached.
- A drawing is looked at before it's believed. One that can't be seen (hidden, see-through, off the page, or
  a blank picture) is no drawing, so it falls back to stories or is reported as not drawn. One that claims
  the element's own words must show exactly those words, in a colour that differs from what's behind them.
  Otherwise it says it isn't drawn with them, and the element needs evidence. Drawings made before this
  check are drawn again.
- A sample's bare words beside an icon-font glyph are replaced, instead of the glyph being given the words.
- An icon-only button's aria-label no longer counts as words it should show, when a photo recorded none.
- Label Review: a card with no clear answer shows its closest candidates, drawn with the element's own words,
  and is held out if none is drawn. A gap card says the system has no such component and shows the suggested
  stand-in where there is one. The heading no longer ends with nothing.
- The render log counts real drawings: "N of M drawn with their props", how many have no picture, and why.
- A review card showed one photo per look, so an element with its own photo appeared only as a small
  thumbnail of another element's (same classes, sometimes other words). Every element with a photo now
  has its own labelled tile: its photo at card scale, where it sits, its source label, match and code
  button. Elements that look and read the same sit together, marked as such, each with its own tile.
- No near-empty review candidates. An element with no usable photo (none, blank, covered, a weak match,
  markup only, or drawn with guessed props) or no exact proposal with its own words says "Needs evidence
  before review", with the plain reason and what would fix it. Its card offers no decision for it, and it
  is left out of `dsa labels queue` and of Label Review. An isolated render (recorded props) counts,
  labelled as such. Code on an uncaptured card is behind a disclosure.

- History labels paired a removed raw line with an added component line by their order in a hunk, so a
  wrapper `<div>` could become a `Button` and a button whose icon changed could become an `Icon`. Pairs
  are now read from both versions of the file (`historyPairsInFile`): a removed raw element pairs with an
  added system component whose host tag matches, nearest first by position in the hunk, one to one.
  Render slots don't count, an element still there afterwards (only a child changed) is not a label,
  dynamic props make a pair unsure, and vendored and non-product files are skipped. A component imported
  through the app's owned copy of the system (`~/components/ui/button`) counts when its name is one of the
  system's components, since older code often imported it that way. A part whose host tag only comes from
  its signature pairs with a raw `<button>` only when the button played that part: a Trigger needs an
  opener (`aria-haspopup`, `aria-expanded`, or an onClick that sets or toggles an open state), an Item needs
  an item role (menuitem, option, tab), and Content never pairs with a raw button.
- Props compare by one rule on both sides (`canonicalProps`): each component's own defaults filled in,
  from its cva defaultVariants. History labels store them filled; `dsa bench` reads them from the run's
  `signatures.json` (`--signatures`, or the data folder's).
- `dsa labels split --seal <share>` sets aside a sealed test set first (a salted hash of app and file,
  reproducible), writing `<prefix>.sealed.jsonl` and `<prefix>.open.jsonl`, and folds only the open part.
- A migrated label named only the size prop that was written, even when the element's className overrode
  it (`size="icon" className="size-7"` renders 28px). The size whose own pixels match the render is now an
  acceptable alternative, with the system's tokens followed to their values.
- `dsa labels migrated` labelled components in another component's render slot (`render={<Button/>}`),
  which the scanner never counts, so those labels could never match. They are skipped.
- `dsa labels` ran `git status` on the apps it reads, which rewrites their `.git/index`. It now reads
  them with plumbing only (`rev-parse`, `diff-index` with each listed file confirmed by `hash-object`
  against HEAD, `log`, `show`), all with `GIT_OPTIONAL_LOCKS=0`.
- `dsa labels migrated` labelled vendored copies of other code (`vendor/`) and non-product files (stories
  folders, examples, demos, stubs, docs) that the scanner never reads, so those labels could never match.
  It now skips them, keeping a local copy of the engine scanner's list.
- `dsa bench` matched a label only on the first line of an element. A label may now name any line of a
  multi-line opening tag (`openEndLine`, when the scan records it).
- The trust rubric counted one problem several times and assumed what the card shows. It now has
  eleven checks, each a pass, a fail or not applicable, and a check that needs another doesn't apply
  when that one fails: "current element shown" replaces C1/C2/C3/C6, so a missing photo counts once.
  The photo label, the proposal label, side by side at one scale and "the place opens the code" are read
  from the rendered card (`card-dom.ts`'s `PROBE_CARDS`; `onReviewPage` in @snds/dsa-review opens a
  published page and shows every card), never from constants; without a rendered card they are
  "untested". "Proposal drawn exactly" and "own content where it can be carried" are separate checks,
  containers are not applicable to the second, and "the system has something to draw" is its own class
  (proposals record `noSource`). Unused, lab, excepted and ignored elements are reported as counts.
- Reasons in plain words now catch utility classes (`px-2`, `size-5`, `hover:bg-zinc-12`) and CSS
  variables (`--radius-md`), which passed before.
- The confidence cap counted a photo of another element with the same classes as evidence; the trust
  rubric didn't, so cards were "ready" on a look-alike's photo. Both now take the element's own photo
  only: the same classes can draw differently (other words, another parent, a state), and the card
  labels that photo with the other element's place. The rubric flags such cards (`siblingPhoto`).

- The tagger put its marks between a component's name and its type arguments (`<Table data-dsa-use="…"<Row>`),
  which isn't JSX: a file with such an element answered 500 and the app didn't render. Marks now go after
  the type arguments. The transform is also fail safe: its output is parsed again, and a file it would break
  gets its source tags alone, else is served as written, with one line naming the file.
### Changed

- Screenshots confirm a pick; they never switch it. When the running app looks more like another variant
  (at least 60% alike and 0.15 ahead of the pick), the pick stays, its confidence drops under the review
  threshold, and the other variant is offered as an alternative ranked below it. A pick the rendering
  clearly contradicts (under 40% alike, another variant 80% or more), with nothing in the classes against
  it, becomes `unclear`. `applyRenderedEvidence` reports `disagreed` and `unclear`; `switched` is always 0.

### Fixed

- dsa ran `git status` on checkouts it only reads (the token scan's new-code check, the live check), and
  `git status` rewrites the index. Those reads now use plumbing only (`src/engine/git-read.ts`):
  `git diff-index --name-only HEAD --`, with each listed file confirmed by comparing `git hash-object` with
  the blob at HEAD, untracked files from `git ls-files --others`, and `GIT_OPTIONAL_LOCKS=0` throughout.
- "Ready" is decided on a pooled band of calibrated scores across decision paths, where labels add up.
  The band is every score at or above a cut; the cut is the lowest score whose band (all paths' labels at
  or above it) has a one-sided 95% lower bound of at least 0.99 (`readyCut`). The element's own path must
  show no error among its labels in that band. With no such cut, nothing is ready. The cut is fitted on
  the labels given and applies unchanged to every element, so a held-out fold is judged by the training
  fold's cut. Per-path fits still set the order. Points that share a score start as one isotonic block.
- A calibrated block that isn't ready was flattened to one score under the bar, which erased ranking and
  coverage. It now keeps its measured precision, squeezed into [0, threshold) in order (`squeeze`).
- Isotonic calibration left equal neighbouring scores in separate one-label blocks, so a clean top band
  never had enough labels for its lower bound. Equal neighbours now pool into one block.
- A square button with no side padding whose content is passed in (`size-7`, `{children}`) took a text
  size of the same height (xs). A square, unpadded box now takes an icon size (icon-sm).
- A filled icon button (`bg-secondary` at rest) was always proposed as ghost. Its fill now picks the
  variant; only an unfilled icon button is ghost.
- Elements a render function returns (`render={({ field }) => <input …/>}`, as form libraries use) were
  skipped as if they were a component's own `render={<button/>}` element. Crossing a function now stops
  that check.
- Labels may name any line of a multi-line opening tag (`openEndLine` on each evaluation).
- Labels matched almost nothing on a real run: they were matched by element hash (which hashes the
  element's source text, not dsa's fingerprint) and by an exact file path. They now match by id, else by
  app, line and a file path that may carry a leading folder, and props compare as the bench compares
  them ("default" is the same as unset).
- Outlined buttons were read as secondary when their classes hide the border first and colour it later
  (`border border-transparent … border-border`, as copied or rendered markup has it). The border was read
  as "none", which ruled the outline variant out. Border classes now resolve last-wins, as `cn()` does.

- An app whose page rewrites its own URL as it loads (a home that redirects, or sets a hash) aborts the
  navigation that brought the crawler there, though the app loaded. That now counts as arrived (on the app's
  origin, document loaded), in pass 1, profiles and drawings, and drawings go to the URL the home page
  landed on, not back to the bare origin: every drawing on such an app had failed.
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
