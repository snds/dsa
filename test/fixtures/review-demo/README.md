# Review demo overlay

Laid over a copy of `acme-monorepo` by `scripts/review-demo.mjs`, so the element review has real evidence
to show: a Button with `data-slot` and cva variants, raw buttons in two apps (text, icon-only, a toggle,
a `.map()` list, a table), the built pages those apps ship, and a tiny built Storybook. The crawler
photographs the built pages and the renderer draws proposals from the Storybook, the way a real system's
review runs. Made-up names only.

Some elements are hard on purpose: an icon button whose icon is transparent until hover, and identical
"Export" buttons in two files of two apps.
