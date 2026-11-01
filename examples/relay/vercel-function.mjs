// The dsa scan relay as a Vercel Function, at https://<project>/api/relay/. docs/relay.md has the settings.
//
// Save as api/relay/[...path].mjs, add @snds/dsa to package.json, and set the DSA_RELAY_* variables
// in the project's Environment Variables (the secret ones as Sensitive).
// DSA_RELAY_URL is https://<project>/api/relay/; the GitHub App's callback URL is …/api/relay/auth/callback.
import { relayFromEnv } from "@snds/dsa/relay";

const relay = relayFromEnv({ log: (m) => console.log(m) });
const handle = (request) => relay(request, process.env);

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
