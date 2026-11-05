# Reach manifest

An app can tell dsa how to reach its own screens, so the crawler looks things up instead of searching for
them. It's opt-in and for development builds only. dsa works without it, but with it a view behind a nav
value, a wizard step or a seeded record is one call away.

There are two forms, and an app can use both.

## In the dev build: `window.__DSA__`

```js
if (import.meta.env.DEV) {
  window.__DSA__ = {
    // Every route the app can show, as strings ("#/prints/PRT-1/history", "/settings/advanced").
    routes: () => allRoutes(),
    // Named states: a name, or { name, reveals: [files it shows] } so the crawler tries the right ones first.
    states: () => [
      { name: 'image-editor', reveals: ['src/app/components/ImageEditorModal.tsx'] },
      'settings-danger-zone',
    ],
    // Put a named state on: navigate, set the app's own state, open the dialog.
    go: async (name) => { /* … */ },
    // Optional: load the fixed data the states expect, before each go().
    seed: async () => { /* … */ },
  };
}
```

The crawler reads `routes()` and `states()` on the app's first page. The routes go first in its queue. Then,
for each state (those whose `reveals` name a missing element's file first), it opens the first page, calls
`seed()` when there is one, then `go(name)`, and looks. It tries up to 60 states, in a fifth of the time.

## Beside the app: `dsa.reach.json`

For an app that can't add code, the same as a file in its folder:

```json
{
  "routes": ["#/prints/PRT-1/history", "/settings/advanced"],
  "states": [
    { "name": "wizard step 3", "route": "#/wizard", "storage": { "wizardStep": "3" } }
  ]
}
```

Each state with a `route` is a profile: that route, opened with local storage (and `session` storage)
seeded first, no clicking. A `null` value removes a key.
