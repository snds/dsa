// The dsa scan relay on plain Node (22+), behind your HTTPS proxy. docs/relay.md has the settings.
// `npx dsa relay --port 8788` does the same; this is for embedding it in a server of your own.
//
//   DSA_RELAY_URL=https://relay.example.com/ DSA_RELAY_ORIGINS=https://acme.github.io … node node.mjs
import { createRelay, relayOptionsFromEnv } from "@snds/dsa/relay";
import { startRelayServer } from "@snds/dsa/relay/node";

const options = relayOptionsFromEnv(process.env, { log: (m) => console.log(m) });
const server = await startRelayServer(createRelay(options), { port: Number(process.env.PORT ?? 8788), host: process.env.HOST ?? "127.0.0.1", publicUrl: options.publicUrl });
console.log(`dsa relay on ${server.url}, reached as ${options.publicUrl}`);
