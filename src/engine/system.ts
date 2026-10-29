import { NEUTRAL_PROFILE, isProfileSource, type ComponentEntry, type ResolvedProfile } from '../profile.js';

/**
 * The design system the engine is measuring, as the element rules need it: its name in wording, the
 * import sources that are the system, its icon exports, its component list, and its control sizes.
 * It comes from the profile (src/profile.ts); `useSystem` sets it once per run, before any scan.
 *
 * It is module state on purpose: the rules read it deep inside pure functions (a reason's wording, an
 * icon check), and threading it through every call would change every signature the port kept.
 */
export interface EngineSystem {
  /** The system's short name in wording: "No <label> component fits". */
  label: string;
  /** Import sources that are the system (a scope ending in "/" is a prefix). */
  sources: string[];
  /** Import sources whose exports are all icons, and "source#Name" for a single icon export. */
  icons: string[];
  /** The system's components, for spotting a host's hand-built copy of one. */
  components: (root: string) => ComponentEntry[];
  /** Custom properties for control heights, without the leading "--", and their px. */
  controlHeights: Record<string, number>;
  /** Extra regex sources whose classes mark a navigation row. */
  navTokens: string[];
  /** The resolved profile, for anything else. */
  profile: ResolvedProfile;
}

let current: EngineSystem = fromProfile(NEUTRAL_PROFILE);

export function fromProfile(profile: ResolvedProfile, fallbackSources: string[] = []): EngineSystem {
  return {
    label: profile.label,
    sources: profile.sources.length ? profile.sources : fallbackSources,
    icons: profile.icons ?? [],
    components: profile.components ?? (() => []),
    controlHeights: profile.controlHeights ?? {},
    navTokens: profile.navTokens ?? [],
    profile,
  };
}

/** Set the system for the runs that follow. `fallbackSources` (the config's packages) apply when the profile names none. */
export function useSystem(profile: ResolvedProfile, fallbackSources: string[] = []): EngineSystem {
  current = fromProfile(profile, fallbackSources);
  return current;
}

export function system(): EngineSystem {
  return current;
}

/** True when an import source belongs to the system. */
export function isSystemSource(spec: string): boolean {
  const s = current;
  return isProfileSource({ ...s.profile, sources: s.sources }, spec);
}

/** True when `name` imported from `spec` is an icon by the profile's icon list. */
export function isSystemIcon(spec: string, name: string): boolean {
  return current.icons.some(i => {
    const hash = i.indexOf('#');
    return hash === -1 ? i === spec : i.slice(0, hash) === spec && i.slice(hash + 1) === name;
  });
}
