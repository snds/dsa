import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProfile, type DsaProfile } from "../../src/profile.js";
import { useSystem } from "../../src/engine/system.js";
import { registerStore } from "../../src/engine/store.js";
import { resetSystemIndex } from "../../src/engine/host-context.js";
import { openDuckStore } from "../../packages/history/src/index.js";
import acmeSuite from "../fixtures/profiles/acme-suite.mjs";

/**
 * Engine tests run as the analytics suite did with no profile: the acme-suite profile is its built-in
 * defaults under Acme names. The DuckDB store comes from the history add-on.
 */
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(HERE, "..", "fixtures");
export const ACME_ROOT = path.join(FIXTURES, "acme-monorepo");
export const ACME_UI = path.join(FIXTURES, "acme-ui");
export const ACME_PROFILE = resolveProfile(acmeSuite as DsaProfile);

/** Use the acme-suite profile, with any fields replaced. */
export function useAcme(over: Partial<DsaProfile> = {}) {
  resetSystemIndex();
  return useSystem(resolveProfile({ ...(acmeSuite as DsaProfile), ...over }));
}

useAcme();
registerStore(openDuckStore);
export { openDuckStore };
