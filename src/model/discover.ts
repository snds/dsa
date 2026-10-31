import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { DsaConfig } from "../config.js";
import { expandSources } from "../engine/paths.js";
import { discoverWorkspaces } from "../engine/workspaces.js";
import { dsSourceDirs } from "../graph/index.js";

/**
 * Where a design system's code lives, found rather than assumed. Every folder in the repo that could hold a
 * library (each package, and each folder dense with components inside an app) is scored against the
 * signatures any design system leaves, whatever it is written in:
 *
 *   declarations  0.35  components it declares: custom elements, Stencil/Angular decorators, single-file
 *                       components, exported PascalCase components, template macros, CSS class families
 *   variants      0.15  closed sets of options: variant recipes, literal prop unions, modifier classes
 *   tokens        0.10  custom properties, Sass variables, token files and token objects
 *   surface       0.15  a public face: a package with exports, or an index that re-exports components
 *   uses          0.20  files that use it: imports of it, its tags, from outside it or from its own docs,
 *                       stories, demos and tests
 *   stories       0.05  stories or docs pages beside it
 *
 * Expected locations (the packages the config names, its local aliases, an installed package, then the
 * usual folders: packages/*, src/components/ui, lib…) are scored first; the full scan still runs, so a
 * system kept somewhere unusual is found too. A folder is used only at `threshold` (default 0.9) or above;
 * one the config names is the user's word and counts as 0.95 when it holds anything. Below the threshold
 * a folder is listed for a person to confirm (`dsa sources --pin`, or Settings → Sources in the dashboard).
 */

export interface SourceSignal { name: string; score: number; weight: number; detail: string }
export interface SourceCandidate {
  dir: string;
  confidence: number;
  /** Scored first: named by the config, or in a usual place. */
  expected: boolean;
  /** Why it was expected (`config package @acme/ui`, `usual folder`). */
  because?: string | undefined;
  package?: string | undefined;
  /** A family's member folders (the packages one npm scope publishes). */
  members?: string[] | undefined;
  signals: SourceSignal[];
}
export interface SourceDiscovery {
  /** The folders the model reads. */
  accepted: string[];
  /** How they were chosen. */
  how: "pinned" | "expected" | "discovered" | "none";
  threshold: number;
  /** Every scored folder, best first (accepted ones included). */
  candidates: SourceCandidate[];
}

const SKIP = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/coverage/**", "**/.next/**", "**/.nuxt/**", "**/.svelte-kit/**", "**/out/**", "**/*.min.*", "**/*.map", "**/vendor/**"];
const FILES = "**/*.{ts,tsx,js,jsx,mjs,vue,svelte,html,njk,twig,hbs,liquid,css,scss,sass,less,json,md,mdx,astro}";
const USUAL = /^(packages|libs|projects|modules)\/[^/]+$|^packages\/@[^/]+\/[^/]+$|(^|\/)(src\/)?(components\/ui|components|ui|lib|design-system|ds|primitives|registry\/[^/]+)$/;
const NOT_A_HOME = /(^|\/)([\w-]*-)?(tests?|__tests__|fixtures?|e2e|examples?|demos?|playgrounds?|sandbox(es)?|templates?)(\/|$)/;
const DOCS_HOME = /(^|\/)([\w-]*-)?(docs?|website|site|storybook|\.storybook|internal)(-[\w-]*)?(\/|$)|(^|\/)[\w-]*internal[\w-]*(\/|$)/;
const OWN_USE = /(^|\/)(docs?|stories|demos?|examples?|tests?|__tests__|e2e|playgrounds?)(\/|$)|\.(stories|story|test|spec)\.|\.mdx?$/;

interface FileFacts {
  rel: string;
  declares: number;
  /** Tags it declares (acme-button). */
  tags: string[];
  /** Tag stems it writes (<acme-…>), class names it writes in markup, and class blocks it declares. */
  usedStems: string[];
  usedClasses: string[];
  blocks: string[];
  variants: number;
  tokens: number;
  story: boolean;
  imports: string[];
}
interface Pkg { dir: string; name?: string | undefined; surface: boolean; deps: string[] }
interface Unit { dirs: string[]; packages: string[]; surface: boolean; family?: string | undefined }

const cache = new Map<string, { at: number; facts: FileFacts[]; packages: Pkg[] }>();
const posix = path.posix;

export function discoverSources(root: string, config: DsaConfig, options: { threshold?: number } = {}): SourceDiscovery {
  const threshold = options.threshold ?? (config as any).discovery?.threshold ?? 0.9;
  const sys = config.system as DsaConfig["system"] & { path?: string; sources?: string[] };
  if (sys.path || sys.sources?.length) {
    // Pinned: the path and every source, globs expanded (a vendored copy's packages/*), as written relative to the root.
    const dirs = [...new Set([...(sys.path ? [sys.path] : []), ...expandSources(root, sys.sources ?? []).map((d) => path.relative(root, d).split(path.sep).join("/") || ".")])];
    return { accepted: dirs, how: "pinned", threshold, candidates: dirs.map((dir) => ({ dir, confidence: 1, expected: true, because: "pinned in the config", signals: [] })) };
  }
  const { facts, packages } = scanRepo(root);
  const pkgDirs = new Set(packages.map((p) => p.dir));

  // Units: every named package; folders dense with components inside a package with no public face (an
  // app's copy-in components/ui); and families, the packages one npm scope publishes (@acme/button, @acme/card).
  const units = new Map<string, Unit>();
  for (const p of packages) units.set(p.dir, { dirs: [p.dir], packages: p.name ? [p.name] : [], surface: p.surface });
  const owner = (rel: string) => { for (let d = posix.dirname(rel); ; d = posix.dirname(d)) { if (pkgDirs.has(d)) return packages.find((p) => p.dir === d); if (d === "." || d === "") return packages.find((p) => p.dir === "."); } };
  const declaredIn = new Map<string, { declares: number; files: number }>();
  for (const f of facts) {
    if (/\.(json|md|mdx)$/.test(f.rel) || OWN_USE.test(f.rel)) continue;
    // Up to, not across, the package that owns the file: a dense folder never spans packages.
    for (let d = posix.dirname(f.rel); d !== "." && d !== "" && !pkgDirs.has(d); d = posix.dirname(d)) {
      const x = declaredIn.get(d) ?? { declares: 0, files: 0 };
      x.files++;
      if (f.declares) x.declares++;
      declaredIn.set(d, x);
    }
  }
  const dense: string[] = [];
  for (const [d, x] of [...declaredIn].sort((a, b) => a[0].length - b[0].length)) {
    if (x.declares < 5 || x.declares / x.files < 0.4 || units.has(d) || dense.some((o) => d.startsWith(`${o}/`))) continue;
    if (owner(`${d}/x`)?.surface) continue; // a library package already covers its folders
    dense.push(d);
    // Narrow to the child folder holding most of its components (src → src/components/ui).
    let at = d;
    for (;;) {
      const total = declaredIn.get(at)!.declares;
      const child = [...declaredIn].find(([c, y]) => posix.dirname(c) === at && y.declares >= 0.8 * total);
      if (!child) break;
      at = child[0];
    }
    units.set(at, { dirs: [at], packages: [], surface: facts.some((f) => /^index\.(ts|js|mjs)$/.test(posix.basename(f.rel)) && posix.dirname(f.rel) === at) });
  }
  const scopes = new Map<string, Pkg[]>();
  for (const p of packages) { const sc = p.name?.match(/^(@[^/]+)\//)?.[1]; if (sc && p.surface) scopes.set(sc, [...(scopes.get(sc) ?? []), p]); }
  for (const [sc, members] of scopes) if (members.length >= 3) {
    const parent = members.map((m) => m.dir).reduce((a, b) => { while (a !== "." && !(`${b}/`).startsWith(`${a}/`)) a = posix.dirname(a); return a; });
    units.set(`${sc}/*`, { dirs: members.map((m) => m.dir), packages: members.map((m) => m.name!), surface: true, family: `${sc} (${members.length} packages under ${parent})` });
  }

  // Expected first: what the config names, then the usual folders.
  const expected = new Map<string, string>();
  for (const dir of expectedSources(root, config)) expected.set(dir, "named by the config");
  for (const d of units.keys()) if (!expected.has(d) && USUAL.test(d)) expected.set(d, "usual folder");
  for (const d of expected.keys()) if (!units.has(d)) units.set(d, { dirs: [d], packages: [], surface: false });

  const score = (key: string, u: Unit) => {
    const inUnit = (rel: string) => u.dirs.some((dir) => dir === "." || rel === dir || rel.startsWith(`${dir}/`));
    // A nested package is its own unit: its files aren't the parent's (unless it's in the family).
    const nested = [...pkgDirs].filter((o) => !u.dirs.includes(o) && u.dirs.some((dir) => dir === "." || o.startsWith(`${dir}/`)));
    const inside = (rel: string) => inUnit(rel) && !nested.some((n) => rel.startsWith(`${n}/`));
    const own = facts.filter((f) => inside(f.rel));
    const code = own.filter((f) => !OWN_USE.test(f.rel));
    const declares = code.reduce((a, f) => a + f.declares, 0);
    const variants = code.reduce((a, f) => a + f.variants, 0);
    const tokens = own.reduce((a, f) => a + f.tokens, 0);
    const stories = own.filter((f) => f.story).length;
    // Uses: files that import it (its package name, a relative path, or an alias path ending in its folder),
    // write its tags, or write two of its class blocks; from outside it, or from its own docs, stories and demos.
    const stems = new Set(code.flatMap((f) => f.tags.map((t) => t.split("-")[0]!)).filter((x) => x.length >= 2));
    const blocks = new Set(code.flatMap((f) => f.blocks));
    const aliasHit = (spec: string) => {
      const t = spec.replace(/^(@|~|#|\$[\w-]*)\//, "");
      if (t === spec) return false;
      const parts = t.split("/");
      for (let k = parts.length; k >= 1; k--) { const tail = parts.slice(0, k).join("/"); if (u.dirs.some((dir) => dir === tail || dir.endsWith(`/${tail}`))) return true; }
      return false;
    };
    let uses = 0;
    for (const f of facts) {
      if (inside(f.rel) && !OWN_USE.test(f.rel)) continue;
      const hit = f.imports.some((sp) => u.packages.some((n) => sp === n || sp.startsWith(`${n}/`)) || (sp.startsWith(".") ? !inside(f.rel) && inside(posix.normalize(posix.join(posix.dirname(f.rel), sp))) : aliasHit(sp)))
        || (f.tags.length === 0 && f.usedStems.some((x) => stems.has(x)))
        || (blocks.size > 0 && f.usedClasses.filter((c) => blocks.has(c)).length >= 2);
      if (hit && ++uses >= 5) break;
    }
    const sat = (n: number, at: number) => Math.min(1, n / at);
    const signals: SourceSignal[] = [
      { name: "declarations", weight: 0.35, score: sat(declares, 10), detail: `${declares} components declared` },
      { name: "uses", weight: 0.25, score: sat(uses, 3), detail: `${uses >= 5 ? "5+" : uses} files use it` },
      { name: "surface", weight: 0.15, score: u.surface ? 1 : 0, detail: u.surface ? (u.packages.length ? `published as ${u.packages.length > 1 ? `${u.packages.length} packages` : u.packages[0]}` : "an index that re-exports it") : "no public entry" },
      { name: "variants", weight: 0.15, score: sat(variants, 3), detail: `${variants} variant sets` },
      { name: "tokens", weight: 0.05, score: sat(tokens, 20), detail: `${tokens} token definitions` },
      { name: "stories", weight: 0.05, score: sat(stories, 3), detail: `${stories} stories or docs pages` },
    ];
    let confidence = signals.reduce((a, x) => a + x.weight * x.score, 0);
    // Judged by the folder's own name, not its ancestors' (shadcn's system lives inside its docs app).
    const tail = u.family ? "" : u.dirs[0]!.split("/").slice(-2).join("/");
    const penalized = NOT_A_HOME.test(tail) || DOCS_HOME.test(tail);
    if (NOT_A_HOME.test(tail)) confidence *= 0.5;
    else if (DOCS_HOME.test(tail)) confidence *= 0.75;
    const because = expected.get(key);
    // A folder the config names is the user's word: trusted when it holds anything at all.
    if (because === "named by the config" && own.length > 0) confidence = Math.max(confidence, 0.95);
    const cand: SourceCandidate = { dir: u.family ?? key, confidence: Math.round(confidence * 100) / 100, expected: Boolean(because), ...(because ? { because } : {}), ...(u.packages.length === 1 ? { package: u.packages[0] } : {}), ...(u.family ? { members: u.dirs } : {}), signals };
    return { cand, holds: declares > 0 || tokens >= 5, penalized };
  };

  const order = [...units.keys()].sort((a, b) => Number(expected.has(b)) - Number(expected.has(a)));
  const scored = order.map((k) => ({ key: k, unit: units.get(k)!, ...score(k, units.get(k)!) }));
  const pass = (c: SourceCandidate) => c.confidence >= threshold;
  const named = scored.filter((x) => x.cand.because === "named by the config" && pass(x.cand));
  let picked = named.length ? named : scored.filter((x) => pass(x.cand));
  // A member comes in when it looks like part of a system on its own (0.45), or holds a token set (a theme or
  // styles package); tools (a story decorator, a visual-diff viewer) stay out.
  const member = (dir: string) => {
    const y = scored.find((z) => z.key === dir);
    if (!y?.holds || y.penalized) return false;
    return y.cand.confidence >= 0.45 || (y.cand.signals.find((s) => s.name === "tokens")?.score ?? 0) >= 1;
  };
  // A family that passes brings its members that hold components or tokens; tools (a CLI, a lint config) stay out.
  const out = new Set<string>();
  for (const x of picked) {
    if (!x.unit.family) { out.add(x.key); continue; }
    for (const dir of x.unit.dirs) if (member(dir)) out.add(dir);
  }
  // A package that passed on its own also brings the family it belongs to, when that family holds a system.
  if (!named.length) for (const x of scored) if (x.unit.family && !picked.includes(x) && x.unit.dirs.some((d) => out.has(d)) && x.cand.confidence >= 0.6) {
    picked = [...picked, x];
    for (const dir of x.unit.dirs) if (member(dir)) out.add(dir);
  }
  // A folder inside another accepted one adds nothing.
  const dirs = [...out].filter((d, _, all) => !all.some((o) => o !== d && (o === "." || d.startsWith(`${o}/`)))).sort();
  const candidates = scored.map((x) => x.cand).filter((c) => c.expected || c.confidence >= 0.3).sort((a, b) => b.confidence - a.confidence || a.dir.localeCompare(b.dir));
  return { accepted: dirs, how: named.length ? "expected" : dirs.length ? "discovered" : "none", threshold, candidates };
}

/** What the config itself points at: workspaces or package.json files by name, local aliases, an installed package. */
export function expectedSources(root: string, config: DsaConfig): string[] {
  const names = new Set(config.system.packages);
  if (!names.size && !config.system.localAliases?.length) return [];
  const dirs = discoverWorkspaces(root).filter((w) => names.has(w.name)).map((w) => path.relative(root, w.dir) || ".");
  if (dirs.length) return dirs;
  const found = new Set<string>();
  const placed = new Set<string>();
  for (const pjFile of fg.sync("**/package.json", { cwd: root, absolute: true, ignore: ["**/node_modules/**", "**/dist/**"], deep: 5 })) {
    try {
      const name = JSON.parse(fs.readFileSync(pjFile, "utf8")).name;
      if (names.has(name)) { found.add(path.relative(root, path.dirname(pjFile)) || "."); placed.add(name); }
    } catch { /* unreadable */ }
  }
  // Copy-in source reached through local aliases (`@/components/ui` → src/components/ui).
  for (const d of dsSourceDirs(root, config)) {
    const abs = path.resolve(root, d);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) found.add(path.relative(root, abs) || ".");
  }
  // A consumer repo: the system is an installed package. Read it there.
  for (const name of names) {
    if (placed.has(name)) continue;
    const installed = path.join(root, "node_modules", name);
    if (fs.existsSync(path.join(installed, "package.json"))) found.add(path.relative(root, installed));
  }
  return [...found].sort();
}

// ---------- the one pass over the repo ----------

function scanRepo(root: string) {
  const abs = path.resolve(root);
  const hit = cache.get(abs);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const facts: FileFacts[] = [];
  const packages: Pkg[] = [];
  for (const file of fg.sync(FILES, { cwd: abs, ignore: SKIP, dot: false }).sort()) {
    const rel = file.replace(/\\/g, "/");
    let text: string;
    try { text = fs.readFileSync(path.join(abs, rel), "utf8"); } catch { continue; }
    if (text.length > 2_000_000) continue;
    if (rel.endsWith("package.json")) {
      try {
        const j = JSON.parse(text);
        // A package.json with no name is a subpath stub (primevue/button/package.json), not a package.
        if (j.name) packages.push({ dir: path.posix.dirname(rel), name: j.name, surface: Boolean(j.exports || j.main || j.module || j.svelte || j.style || j.sass || j.files), deps: Object.keys({ ...j.dependencies, ...j.peerDependencies }) });
      } catch { /* not JSON */ }
      continue;
    }
    facts.push(factsOf(rel, text));
  }
  const out = { at: Date.now(), facts, packages };
  cache.set(abs, out);
  return out;
}

function factsOf(rel: string, text: string): FileFacts {
  const ext = path.extname(rel);
  const tags: string[] = [];
  let blocks: string[] = [];
  let declares = 0, variants = 0, tokens = 0;
  if (/\.(ts|tsx|js|jsx|mjs)$/.test(ext)) {
    for (const m of text.matchAll(/(?:customElements\.define|@customElement|\b[A-Z]\w*\.define|\b\w*(?:[dD]efine|[rR]egister)\w*)\(\s*['"`]([a-z][\w$-]*-[\w${}-]+)['"`]/g)) { declares++; tags.push(m[1]!); }
    const tagMap = text.match(/interface\s+HTMLElementTagNameMap\s*\{([^}]*)\}/);
    if (tagMap) for (const m of tagMap[1]!.matchAll(/['"]([a-z][\w-]*-[\w-]+)['"]\s*:/g)) if (!tags.includes(m[1]!)) { declares++; tags.push(m[1]!); }
    for (const m of text.matchAll(/@Component\(\s*\{[\s\S]{0,600}?\b(?:tag|selector)\s*:\s*['"`]([^'"`]+)['"`]/g)) { declares++; const t = m[1]!.match(/^[a-z][\w-]*-[\w-]+/)?.[0]; if (t) tags.push(t); }
    if (/\.(tsx|jsx)$/.test(ext)) {
      const listed = [...text.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((m) => m[1]!.split(",")).filter((n) => /^\s*(?:\w+\s+as\s+)?[A-Z][a-z]\w*\s*$/.test(n)).length;
      declares += Math.min(3, (text.match(/export\s+(?:default\s+)?(?:const|function|class)\s+[A-Z]\w*/g) ?? []).length + listed);
    }
    else if (/forwardRef|defineComponent\(|genericComponent/.test(text)) declares += Math.min(3, (text.match(/export\s+(?:const|function|class)\s+[A-Z]\w*/g) ?? []).length);
    variants += (text.match(/\bvariants\s*:\s*\{/g) ?? []).length;
    variants += (text.match(/\b(?:variant|size|tone|color|appearance|kind|emphasis|intent|severity|shape)\??\s*:\s*(?:HintedString<)?['"][\w-]+['"]\s*\|/g) ?? []).length;
    variants += (text.match(/type\s*:\s*['"]enum['"]/g) ?? []).length; // prop definitions: { type: 'enum', values: [...] }
    tokens += (text.match(/define\w*Tokens|createTheme|\{\s*value\s*:\s*['"]/g) ?? []).length;
    // Constant palettes and scales: `blue60: '#0f62fe'`, `spacing05: '1rem'`.
    tokens += (text.match(/[:=]\s*['"](?:#[0-9a-fA-F]{3,8}|-?\d*\.?\d+(?:px|rem|em|ms))['"]/g) ?? []).length;
  } else if (ext === ".vue" || ext === ".svelte") {
    if (!/^[+_]|\/(\+|_)|(^|\/)(App|index|app)\.(vue|svelte)$/.test(rel)) declares++;
    variants += (text.match(/\b(?:variant|size|tone|color|appearance|kind|severity)\??\s*:\s*['"][\w-]+['"]\s*\|/g) ?? []).length;
  } else if (/\.(njk|twig|hbs|liquid)$/.test(ext)) {
    declares += (text.match(/\{%-?\s*macro\s+\w+/g) ?? []).length;
  } else if (/\.(s?css|sass|less)$/.test(ext)) {
    // A class family: a block and at least one class extending it (btn, btn-primary; card, card__title).
    const classes = new Set([...text.matchAll(/(?:^|[\s,}])\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:(?:__|--)[a-z0-9-]+)?)(?=[\s,{:.[>+~)])/gm)].map((m) => m[1]!));
    blocks = [...classes].filter((c) => [...classes].some((o) => o !== c && (o.startsWith(`${c}-`) || o.startsWith(`${c}__`))));
    declares += Math.min(5, blocks.length);
    // A variant set: a block with two or more extensions (btn-primary, btn-outline; card--raised, card--flat).
    variants += blocks.filter((b) => [...classes].filter((o) => o.startsWith(`${b}-`) && !o.startsWith(`${b}__`)).length >= 2).length;
    tokens += (text.match(/^\s*(--[\w-]+|\$[\w-]+)\s*:/gm) ?? []).length;
  } else if (ext === ".json") {
    if (/\.tokens\.json$|(^|\/)tokens\//.test(rel)) tokens += (text.match(/"\$?value"\s*:/g) ?? []).length;
  }
  const imports = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*|@import\s+|@use\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  const usedStems = [...new Set([...text.matchAll(/<([a-z][a-z0-9]*)-[a-z]/g)].map((m) => m[1]!))];
  const usedClasses = /\.(s?css|sass|less|json)$/.test(ext) ? [] : [...new Set([...text.matchAll(/\bclass(?:Name)?\s*=\s*["'`{]([^"'`}]{1,400})/g)].flatMap((m) => m[1]!.split(/\s+/)).filter((c) => /^[a-z][\w-]*$/.test(c)))];
  return { rel, declares, tags, usedStems, usedClasses, blocks, variants, tokens, story: /\.(stories|story)\.|\.mdx$/.test(rel), imports };
}
