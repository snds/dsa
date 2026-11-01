// The dsa scan relay on Cloudflare Workers. docs/relay.md has the settings.
//
//   npm i @snds/dsa
//   wrangler secret put DSA_RELAY_CLIENT_SECRET     (and DSA_RELAY_RUNNER_TOKEN, DSA_RELAY_SESSION_SECRET)
//   # wrangler.toml [vars]: DSA_RELAY_URL, DSA_RELAY_ORIGINS, DSA_RELAY_REPO, DSA_RELAY_CLIENT_ID, …
//   wrangler deploy
//
// The GitHub App's callback URL is DSA_RELAY_URL + "auth/callback".
import { relayFromEnv } from "@snds/dsa/relay";

const relay = relayFromEnv({ log: (m) => console.log(m) });

export default {
  fetch: (request, env) => relay(request, env),
};
