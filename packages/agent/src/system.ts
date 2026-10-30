import path from 'node:path';
import { createRequire } from 'node:module';
import { NEUTRAL_PROFILE, type AgentProfile, type EngineContext, type ResolvedProfile } from '@snds/dsa';

/**
 * The design system the agent works with, set once per command or request from the run's profile
 * (like the core's useSystem). Everything the agent knows about the system's own tools (its docs, its
 * MCP server, its checker) comes from the profile's `agent` section.
 */
let current: ResolvedProfile = NEUTRAL_PROFILE;

export function useProfile(p: ResolvedProfile): void {
  current = p;
}
export const profile = (): ResolvedProfile => current;
export const tools = (): AgentProfile => current.agent ?? {};
/** The system's short name for wording ("the Acme docs"). */
export const label = (): string => current.label;

/** dsa's own CLI, for MCP server entries that start `dsa mcp`. */
export const DSA_CLI = (() => {
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve('@snds/dsa/package.json')), 'dist', 'cli.js');
  } catch {
    return process.argv[1] ?? 'dsa';
  }
})();

/** CLI arguments that reproduce a run context for `dsa mcp`: the repo, data folder, config and profile. */
export function contextArgs(ctx: Pick<EngineContext, 'root' | 'dataDir' | 'loaded' | 'profileSpec'>): string[] {
  return [
    '--root', ctx.root, '--data', ctx.dataDir,
    ...(ctx.loaded.configPath ? ['--config', ctx.loaded.configPath] : []),
    ...(ctx.profileSpec ? ['--profile', ctx.profileSpec] : []),
  ];
}
