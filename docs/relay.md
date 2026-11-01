# The scan relay: Re-scan for a published dashboard

A published dashboard (`dsa publish`) is a folder of static files, so it has nothing that can start a
scan by itself. The **scan relay** is a small service that can. It keeps the credential that starts
the scan workflow as its own secret, and it lets in only people who sign in and have the right
access to the repo. Viewers press Re-scan, sign in with GitHub once per tab, and watch the progress.
They never see or paste a token.

```
 viewer's browser                    scan relay (your host)                      GitHub
 ────────────────                    ──────────────────────                      ──────
 Re-scan ───────────────────────────▶ POST scan
                                      no session? 401 ─▶ "Sign in with GitHub"
 Sign in with GitHub ───────────────▶ GET auth/start ──────────────────────────▶ authorize (no scopes)
                      ◀───────────── GET auth/callback ◀──────────────────────── code
                                      exchange code (client secret), learn who signed in,
                                      check their access with the relay's token
 back on the page, with a session ◀── 302 to the dashboard  #dsa-relay=<session>
 Re-scan (session) ─────────────────▶ POST scan ──────────────────────────────▶ workflow_dispatch
 banner + progress ─────────────────▶ GET scan/status ─────────────────────────▶ the run and its steps
```

## What the relay does

- **Holds the runner credential.** `DSA_RELAY_RUNNER_TOKEN` is a secret in the relay's environment.
  It never reaches the browser, the report, history or logs.
- **Signs viewers in** with GitHub's OAuth web flow. The relay keeps the client secret and does the
  code exchange. It asks GitHub for **no scopes**. It uses the viewer's GitHub token once, to learn
  who signed in, and then drops it.
- **Checks access** to the repo with its own token
  (`GET /repos/{repo}/collaborators/{login}/permission`). It does this at sign-in and again before
  every scan, so someone removed from the repo can't keep scanning. The default bar is **write**
  access (`DSA_RELAY_MIN_PERMISSION`).
- **Gives the viewer a session**: a short-lived token the relay signs (HMAC-SHA256, default 8 hours).
  It is not a GitHub token. It reaches the page two ways:
  - As an **HttpOnly, Secure cookie** scoped to the relay's path. This works when the browser sends
    it, which is always the case on the same site.
  - In the URL fragment after sign-in (`#dsa-relay=…`). The page moves it into `sessionStorage` and
    removes it from the address bar at once. A fragment is never sent to a server. This covers
    browsers that block third-party cookies, such as Safari, when the relay is on another site.
  It is never put in `localStorage`. It ends when the tab closes or the session expires.
- **Refuses cross-site requests.** Starting a scan or signing out needs the dashboard's origin
  (`DSA_RELAY_ORIGINS`) *and* the `X-DSA-Relay` header. A custom header forces a CORS preflight,
  which only the listed origins pass, so another site can't post a scan. CORS answers only those
  origins. Sign-in returns only to them, so it can't be used as an open redirect. The sign-in state
  is signed and tied to a cookie in the same browser, which stops login CSRF (cross-site request
  forgery).
- **Runs one scan at a time.** If a scan is already going, whether a teammate started it or the
  schedule did, a second press gets that run (`409`) and follows it. Each viewer may start
  `DSA_RELAY_RATE` scans per window. The default is 3 per 10 minutes, counted in memory on each
  relay instance.
- **Reads progress on the server.** It polls the workflow run and its jobs' steps, and maps them to
  queued, step n of m, done or failed. It reuses its answers for a few seconds, so many viewers
  polling don't use up the relay's GitHub API allowance. Anyone who can reach the relay sees
  progress, without the run's link. Signed-in viewers also get the link.
  `DSA_RELAY_STATUS=signed-in` hides progress from everyone else.

The relay is one handler written to the Web Fetch API (standard `Request` in, `Response` out), in
[`src/relay/`](../src/relay/index.ts). It runs anywhere that API does: inside `dsa serve`, alone
with `dsa relay`, or on a serverless host. The scan itself goes through the runner contract
(`trigger`, `status`, `listActive`). GitHub's `workflow_dispatch` is the first runner. A `webhook`
runner covers any other CI. You can also pass your own runner to `createRelay`.

### Why a GitHub App (an OAuth App works too)

Sign-in uses GitHub's OAuth web flow, which both kinds of app offer. A **GitHub App** is
recommended:

- Its sign-in grants nothing by default. Its user tokens expire after 8 hours.
- Organization owners can see it and restrict it.
- It works the same on GitHub Enterprise Server.

An **OAuth App** works with the same settings, because the relay asks for no scopes. It is a little
less to set up. Either way the relay checks access with its own token, not the viewer's, so the
choice only changes how sign-in is registered.

## Set it up

You need four things:

1. **A GitHub App for sign-in.**
   - On GitHub: Settings → Developer settings → GitHub Apps → New GitHub App. For an organization,
     use the organization's settings.
   - **Callback URL**: the relay's address followed by `auth/callback`, for example
     `https://relay.example.com/auth/callback` or `https://example.com/dsa/relay/auth/callback`.
     It must match `DSA_RELAY_URL` exactly.
   - Turn **Expire user authorization tokens** on. Turn **Webhook** off.
   - **Permissions**: none. Leave every one at "No access".
   - Where it can be installed: "Only on this account".
   - Note the **Client ID**, then generate a **client secret**.
   - It doesn't need to be installed on the repo for sign-in.
2. **A runner token.** This is a fine-grained personal access token, ideally from a bot or service
   account. Repository access: only the scanned repo. Permissions: **Actions: Read and write**.
   (Metadata: Read comes with it; the relay uses it to read collaborators' access.) Set an expiry,
   and put renewing it on the calendar.
3. **A session secret.** Any random string of 32 or more characters, for example
   `openssl rand -base64 48`. Changing it signs everyone out.
4. **A host for the relay** (see below), reachable over HTTPS.

Then set these in the relay's environment. Use your host's encrypted secrets for the secret ones.

| Variable | Secret? | What |
|---|---|---|
| `DSA_RELAY_URL` | no | The relay's own address as browsers reach it, with any sub-path, ending in `/`. |
| `DSA_RELAY_ORIGINS` | no | The dashboard's origin(s), comma-separated: `https://acme.github.io`. |
| `DSA_RELAY_REPO` | no | `owner/name`: the repo whose workflow scans, and whose access decides who may. |
| `DSA_RELAY_CLIENT_ID` | no | The GitHub App's client ID. |
| `DSA_RELAY_CLIENT_SECRET` | **yes** | The GitHub App's client secret. |
| `DSA_RELAY_RUNNER_TOKEN` | **yes** | The runner token (step 2). |
| `DSA_RELAY_SESSION_SECRET` | **yes** | The session secret (step 3). |
| `DSA_RELAY_WORKFLOW` | no | The workflow file that scans and deploys (default `dsa.yml`). It needs `workflow_dispatch`. |
| `DSA_RELAY_REF` | no | The branch to run on (default: the repo's default branch). |
| `DSA_RELAY_MIN_PERMISSION` | no | `read`, `triage`, `write` (default), `maintain` or `admin`. |
| `DSA_RELAY_SESSION_HOURS` | no | How long a sign-in lasts (default 8). |
| `DSA_RELAY_RATE` | no | Scans per viewer per window, `max/seconds` (default `3/600`). |
| `DSA_RELAY_STATUS` | no | `public` (default) or `signed-in`: who may see progress. |
| `DSA_RELAY_COOKIE_SAMESITE` | no | `None` (default, for a dashboard on another site), or `Lax` / `Strict` when it shares the relay's site. |
| `DSA_RELAY_GITHUB_SERVER`, `DSA_RELAY_GITHUB_API` | no | For GitHub Enterprise Server (`https://git.example.com`, and `…/api/v3` if different). |
| `DSA_RELAY_PERMISSION_TOKEN` | **yes** | A separate token for access checks, if the runner token can't read collaborators (the webhook runner). |
| `DSA_RELAY_RUNNER` | no | `github` (default) or `webhook`, with `DSA_RELAY_WEBHOOK_TRIGGER` (and `_STATUS`, `_ACTIVE`). The runner token is sent to the webhook as a bearer token. |

Check the settings without starting anything:

```bash
npx dsa relay --check
```

Finally, publish the dashboard with the relay's address. You can put it in the config:

```jsonc
// dsa.config.json
{ "host": { "adapter": "github", "github": { "repo": "acme/site", "workflow": "pages.yml" }, "relay": { "url": "https://relay.example.com/" } } }
```

Or pass it on the command line:

```bash
npx dsa publish --out dist/dsa --relay https://relay.example.com/
```

Without a relay, the published page has no Re-scan button. It says that scans run on their schedule
and on each deploy, and how to add the button. It does not link to the workflow page.

## Where to host it

Each example has the same handler and the same environment. Pick the one closest to what you
already run.

**Inside `dsa serve`.** If you already run the live dashboard on a server, set the `DSA_RELAY_*`
variables before `dsa serve`. The relay is mounted at `DSA_RELAY_URL`'s path, for example
`https://example.com/dsa/relay/` with `--base /dsa/`. The server logs `Scan relay on at …`, or
which settings are missing.

**Alone on Node.** Run `dsa relay --port 8788` behind your HTTPS proxy, or use
[`examples/relay/node.mjs`](../examples/relay/node.mjs).

**Serverless.** These copy into a project of their own:

- Cloudflare Workers: [`examples/relay/cloudflare-worker.mjs`](../examples/relay/cloudflare-worker.mjs).
  Set the secrets with `wrangler secret put`.
- Netlify Functions: [`examples/relay/netlify-function.mjs`](../examples/relay/netlify-function.mjs).
- Vercel Functions: [`examples/relay/vercel-function.mjs`](../examples/relay/vercel-function.mjs).

Each one imports `@snds/dsa/relay`, which uses only the Fetch API and Web Crypto, with no Node
built-ins.

On a serverless host, every instance has its own memory, so the rate limit is per instance. The
one-scan-at-a-time rule still holds everywhere, because the relay asks GitHub whether a run is
already going before it starts one.

## What it can't do

- **The runner token is a standing credential.** The relay is the only thing that holds it, but
  anyone who controls the relay's host or its secrets can start workflows in that repo. Give it the
  narrowest token you can (one repo, Actions only) and an expiry.
- **A session can't be taken back early.** A stolen session works until it expires, even after sign-out.
  Signing out clears it in that browser. Keep `DSA_RELAY_SESSION_HOURS` short, or rotate
  `DSA_RELAY_SESSION_SECRET` to sign everyone out at once. Access is re-checked before each scan, so a
  removed collaborator is refused even with a live session.
- **Script on the dashboard's site can use the tab's session** (it is in `sessionStorage`). Serve
  only dsa's own page from that origin.
