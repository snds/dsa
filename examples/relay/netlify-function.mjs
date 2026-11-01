// The dsa scan relay as a Netlify Function, at https://<site>/relay/. docs/relay.md has the settings.
//
// Save as netlify/functions/dsa-relay.mjs, add @snds/dsa to package.json, and set the DSA_RELAY_*
// variables under Site configuration → Environment variables (mark the secret ones as secret).
// DSA_RELAY_URL is https://<site>/relay/; the GitHub App's callback URL is …/relay/auth/callback.
import { relayFromEnv } from "@snds/dsa/relay";

const relay = relayFromEnv({ log: (m) => console.log(m) });

export default (request) => relay(request, process.env);

export const config = { path: ["/relay", "/relay/*"] };
