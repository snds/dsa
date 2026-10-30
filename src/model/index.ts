import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { DsaConfig } from "../config.js";
import { READABLE, readFile } from "./elements.js";
import { extractConcepts } from "./extract.js";
import { readTokens } from "./tokens.js";
import { typeConcepts } from "./kinds.js";
import { discoverSources } from "./discover.js";
import type { Concept, Declaration, Element, RealizationForm, SystemModel, Token, Use } from "./types.js";

export type { Concept, Declaration, Element, Realization, RealizationForm, SystemModel, Token, Use, Evidence, Tier } from "./types.js";
export { extractConcepts } from "./extract.js";
export { readElements } from "./elements.js";
export { discoverSources, type SourceCandidate, type SourceDiscovery } from "./discover.js";

export interface BuildModelOptions {
  /** Repo root; config paths resolve against it. */
  root: string;
  config: DsaConfig;
  /** Globs of files to read for uses (default: the config's scan.include). */
  include?: string[] | undefined;
}

const DEFAULT_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/coverage/**", "**/*.min.js", "**/*.d.ts"];
const NOT_INTERNAL = /(\.stories\.|\.story\.|\/stories\/|\/examples?\/|\/demos?\/|\/docs?\/|\.test\.|\.spec\.|__tests__)/;

/** One file as the model reads it: its elements with their uses, and the components it declares. */
export interface FileReading {
  file: string;
  /** In a library's own source and not a story, example, doc or test. */
  internal: boolean;
  /** Under one of the libraries' source folders at all. */
  inSource: boolean;
  /** The library whose source holds it, if any. */
  library?: string | undefined;
  elements: { element: Element; uses: Use[] }[];
  declared: Declaration[];
}

export interface RepoReading {
  sources: string[];
  concepts: Concept[];
  tokens: Token[];
  files: FileReading[];
  skipped: { file: string; message: string }[];
  /** Resolve an element to its uses (for a declaration's root, read outside the walk). */
  match: (el: Element, file: string) => Use[];
}

/** A library the model reads: the system itself (the core) or one of its children. */
interface Library {
  name: string;
  core: boolean;
  packages: string[];
  localAliases: string[];
  tagPrefixes: string[];
  sources: string[];
  sourceAbs: string[];
  concepts: Concept[];
  index: Index;
}

/** Read every library's declarations, then every file in the repo, matching each element to concepts. */
export function readRepo({ root, config, include }: BuildModelOptions): RepoReading {
  const absRoot = path.resolve(root);
  const specs = [
    { ...config.system, core: true },
    ...(config.system.children ?? []).map((c) => ({ ...c, core: false, localAliases: c.localAliases ?? [] })),
  ];
  const libs: Library[] = specs.map((spec) => {
    const sources = systemSources(absRoot, { ...config, system: { ...config.system, ...spec, children: [] } } as DsaConfig);
    const concepts = extractConcepts(absRoot, sources, { tagPrefixes: spec.tagPrefixes ?? [] }).map((c) => ({ ...c, key: spec.core ? c.key : `${normKey(spec.name)}:${c.key}`, library: spec.name }));
    return { name: spec.name, core: spec.core, packages: spec.packages ?? [], localAliases: spec.localAliases ?? [], tagPrefixes: (spec.tagPrefixes ?? []).map((t) => t.toLowerCase()), sources, sourceAbs: sources.map((s) => path.resolve(absRoot, s)), concepts, index: indexConcepts(concepts) };
  });
  // Tags, selectors, classes and macros are told apart by their prefixes: one index across libraries.
  // Imports resolve within the library that owns the import.
  const global = indexConcepts(libs.flatMap((l) => l.concepts));
  const libraryOf = (spec: string, file: string) =>
    libs.find((l) => [...l.packages, ...l.localAliases].some((p) => spec === p || spec.startsWith(`${p}/`))) ??
    (spec.startsWith(".") ? libs.find((l) => l.sourceAbs.some((d) => isInside(path.resolve(path.dirname(file), spec), d))) : undefined);
  const match = (el: Element, file: string) => matchElement(el, global, (spec) => libraryOf(spec, path.resolve(absRoot, file)));

  const files = fg.sync(include ?? config.scan.include, { cwd: absRoot, absolute: true, ignore: [...DEFAULT_EXCLUDE, ...config.scan.exclude] }).filter((f) => READABLE.test(f)).sort();
  const readings: FileReading[] = [];
  const skipped: { file: string; message: string }[] = [];
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const rel = path.relative(absRoot, file);
    let read: ReturnType<typeof readFile>;
    try { read = readFile(rel, text); } catch (e) { skipped.push({ file: rel, message: String((e as Error)?.message ?? e).split("\n")[0]! }); continue; }
    const home = libs.find((l) => l.sourceAbs.some((d) => isInside(file, d)));
    const inSource = Boolean(home);
    const ownCode = inSource && !NOT_INTERNAL.test(`/${rel.replace(/\\/g, "/")}`);
    // A use is internal when a library's own code uses its own component; a child using the core consumes it.
    const internal = ownCode && Boolean(home?.core);
    // Readers append macro calls after elements; keep each file in line order.
    const elements = read.elements.sort((a, b) => a.line - b.line).map((element) => ({ element, uses: match(element, rel).map((u) => (ownCode && (u.library ?? libs[0]!.name) === home!.name ? { ...u, internal: true } : u)) }));
    readings.push({ file: rel, internal, inSource, ...(home ? { library: home.name } : {}), elements, declared: read.declared });
  }
  // Concepts known only because consumers write them: an import from a library, or a tag with its prefix.
  for (const l of libs) for (const name of [...l.index.unknown].sort()) {
    const isTag = name.includes("-");
    const display = isTag ? pascal(name.slice(l.tagPrefixes.find((p) => name.startsWith(p))?.length ?? 0)) : name;
    const key = l.core ? normKey(display) : `${normKey(l.name)}:${normKey(display)}`;
    if (global.byKey.has(key)) continue;
    const c: Concept = { key, name: display, library: l.name, role: "component", realizations: [isTag ? { form: "tag", tag: name, evidence: { file: "(consumer tags)", extractor: "tag-prefix", tier: "convention" } } : { form: "import", symbol: name, evidence: { file: "(consumer imports)", extractor: "system-import", tier: "convention" } }] };
    l.concepts.push(c);
    global.byKey.set(key, c);
  }
  // Kinds: type every concept by the name-free archetypes.
  typeConcepts(libs.flatMap((l) => l.concepts));
  // Tokens and their bindings, per library (a child's tokens are its own).
  const tokens: Token[] = [];
  for (const l of libs) for (const t of readTokens(absRoot, l.sources, l.concepts).tokens) if (!tokens.some((x) => x.name === t.name)) tokens.push(t);
  return { sources: libs.flatMap((l) => l.sources), concepts: libs.flatMap((l) => l.concepts), tokens, files: readings, skipped, match };

  function matchElement(el: Element, ix: Index, owner: (spec: string) => Library | undefined): Use[] {
    const out: Use[] = [];
    const add = (key: string | undefined, form: RealizationForm["form"], modifiers?: string[], part?: string) => {
      if (!key || out.some((u) => u.concept === key && u.part === part)) return;
      const library = ix.byKey.get(key)?.library ?? libs.find((l) => l.index.byKey.has(key) || key.startsWith(`${normKey(l.name)}:`))?.name;
      out.push({ concept: key, file: el.file, line: el.line, form, ...(library ? { library } : {}), ...(part ? { part } : {}), ...(modifiers?.length ? { modifiers } : {}) });
    };
    if (el.macro) { add(ix.macro.get(el.tag), "macro"); return out; }

    const isComponentTag = /^[A-Z]/.test(el.tag) || el.tag.includes(".");
    if (isComponentTag) {
      if (el.importSource !== undefined) {
        const lib = owner(el.importSource);
        if (lib) {
          const li = lib.index;
          const ns = (k: string) => (lib.core ? k : `${normKey(lib.name)}:${k}`);
          const [head, ...rest] = el.tag.split(".");
          const local = el.importedName && el.importedName !== "*" && el.importedName !== "default" ? el.importedName : head!;
          const member = rest.join("");
          const resolve = (n: string) => li.symbol.get(n) ?? (li.byKey.has(ns(normKey(n))) ? ns(normKey(n)) : undefined);
          // An import from a library that no extractor declared is still that library's: name it by the import.
          const orImported = (key: string | undefined, name: string) => key ?? (/^[A-Z]/.test(name) ? (li.unknown.add(name), ns(normKey(name))) : undefined);
          if (!member) add(orImported(resolve(local) ?? resolve(path.basename(el.importSource).replace(/\.(vue|svelte|[jt]sx?)$/, "")), local), "import");
          else {
            // Dialog.Root → Dialog. Dialog.Content → DialogContent when the library exports that name;
            // otherwise a part of its parent (ActionMenu.Button is ActionMenu's button, not the Button).
            const parent = resolve(local);
            const combined = member === "Root" ? undefined : resolve(`${local}${member}`);
            if (member === "Root") add(orImported(parent, local), "import");
            else if (combined) add(combined, "import");
            else if (parent) add(parent, "import", undefined, member);
            else if (/^[A-Z]/.test(local)) add(orImported(undefined, local), "import", undefined, member);
            else if (/^[a-z]/.test(head!) || el.importedName === "*") add(resolve(member), "import"); // import * as ui; <ui.Button>
          }
        }
      } else {
        // No import binding: a globally registered tag (Vue plugin, auto-import), or a docs example that
        // writes an exported component without its import (Markdown, MDX).
        add(ix.tag.get(el.tag) ?? ix.symbol.get(el.tag), ix.tag.has(el.tag) ? "tag" : "import");
      }
    } else if (el.tag.includes("-")) {
      const tag = el.tag.toLowerCase();
      // A tag with a library's configured prefix is that library's, declared or not (<ds-data-table> → DataTable).
      const byPrefix = ix.tag.get(tag) ? undefined : libs.find((l) => l.tagPrefixes.some((p) => tag.startsWith(p) && tag.length > p.length));
      if (byPrefix) {
        byPrefix.index.unknown.add(tag);
        const rest = tag.slice(byPrefix.tagPrefixes.find((p) => tag.startsWith(p))!.length);
        add(byPrefix.core ? normKey(rest) : `${normKey(byPrefix.name)}:${normKey(rest)}`, "tag");
      } else add(ix.tag.get(tag), "tag");
    }

    if (ix.selectors.length) {
      const attrs = new Set(Object.keys(el.attributes).map(attrName));
      for (const sel of ix.selectors) if ((!sel.tag || sel.tag === el.tag) && attrs.has(sel.attribute)) add(sel.key, "selector");
    }
    for (const c of el.classes) {
      const key = ix.cls.get(c);
      if (!key) continue;
      const mods = el.classes.filter((x) => x !== c && (x.startsWith(`${c}-`) || x.startsWith(`${c}__`))).map((x) => x.slice(c.length).replace(/^-+|^_+/, ""));
      add(key, "class", mods);
    }
    return out;
  }
}

/** Build the system model: the system's concepts and realizations, then every use in the repo. */
export function buildSystemModel(options: BuildModelOptions): SystemModel {
  const r = readRepo(options);
  return { system: options.config.system.name, sources: r.sources, concepts: r.concepts, tokens: r.tokens, uses: r.files.flatMap((f) => f.elements.flatMap((e) => e.uses)), files: { read: r.files.length, skipped: r.skipped } };
}

/** A library's own source folders: pinned in the config, else found (see discover.ts). */
export function systemSources(root: string, config: DsaConfig): string[] {
  return discoverSources(root, config).accepted;
}

// ---------- matching ----------

interface Index {
  byKey: Map<string, Concept>;
  /** Names imported from the library that no extractor declared. */
  unknown: Set<string>;
  tag: Map<string, string>; // exact tag (XBtn) and lowercase tag (x-btn, acme-button)
  symbol: Map<string, string>;
  selectors: { tag?: string | undefined; attribute: string; key: string }[];
  cls: Map<string, string>;
  macro: Map<string, string>;
}

function indexConcepts(concepts: Concept[]): Index {
  const ix: Index = { byKey: new Map(), unknown: new Set(), tag: new Map(), symbol: new Map(), selectors: [], cls: new Map(), macro: new Map() };
  for (const c of concepts) {
    ix.byKey.set(c.key, c);
    for (const r of c.realizations) {
      if (r.form === "tag") { ix.tag.set(r.tag, c.key); if (r.tag.includes("-")) ix.tag.set(r.tag.toLowerCase(), c.key); }
      else if (r.form === "import") ix.symbol.set(r.symbol, c.key);
      else if (r.form === "selector" && r.attribute) ix.selectors.push({ tag: r.tag, attribute: r.attribute, key: c.key });
      else if (r.form === "class") ix.cls.set(r.block, c.key);
      else if (r.form === "macro") ix.macro.set(r.name, c.key);
    }
  }
  return ix;
}

const normKey = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
const pascal = (kebab: string) => kebab.split("-").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
// `[acTooltip]`, `(click)`, `[(value)]`, `:prop`, `v-bind:prop`, `bind:prop` all name the attribute `prop`.
const attrName = (n: string) => n.replace(/^\[\(|\)\]$/g, "").replace(/^[[(]|[\])]$/g, "").replace(/^(v-bind:|bind:|:)/, "");

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
