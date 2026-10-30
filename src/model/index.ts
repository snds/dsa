import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { DsaConfig } from "../config.js";
import { discoverWorkspaces } from "../engine/workspaces.js";
import { READABLE, readElements } from "./elements.js";
import { extractConcepts } from "./extract.js";
import type { Concept, Element, RealizationForm, SystemModel, Use } from "./types.js";

export type { Concept, Element, Realization, RealizationForm, SystemModel, Use, Evidence, Tier } from "./types.js";
export { extractConcepts } from "./extract.js";
export { readElements } from "./elements.js";

export interface BuildModelOptions {
  /** Repo root; config paths resolve against it. */
  root: string;
  config: DsaConfig;
}

const DEFAULT_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/coverage/**", "**/*.min.js", "**/*.d.ts"];
const NOT_INTERNAL = /(\.stories\.|\.story\.|\/stories\/|\/examples?\/|\/demos?\/|\/docs?\/|\.test\.|\.spec\.|__tests__)/;

/** Build the system model: the system's concepts and realizations, then every use in the repo. */
export function buildSystemModel({ root, config }: BuildModelOptions): SystemModel {
  const absRoot = path.resolve(root);
  const sources = systemSources(absRoot, config);
  const concepts = extractConcepts(absRoot, sources, { tagPrefixes: config.system.tagPrefixes ?? [] });
  const index = indexConcepts(concepts);
  const sourceAbs = sources.map((s) => path.resolve(absRoot, s));
  const isSystemImport = (spec: string, file: string) =>
    [...config.system.packages, ...config.system.localAliases].some((p) => spec === p || spec.startsWith(`${p}/`)) ||
    (spec.startsWith(".") && sourceAbs.some((d) => isInside(path.resolve(path.dirname(file), spec), d)));

  const files = fg.sync(config.scan.include, { cwd: absRoot, absolute: true, ignore: [...DEFAULT_EXCLUDE, ...config.scan.exclude] }).filter((f) => READABLE.test(f)).sort();
  const uses: Use[] = [];
  const skipped: { file: string; message: string }[] = [];
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const rel = path.relative(absRoot, file);
    let elements: Element[];
    try { elements = readElements(rel, text); } catch (e) { skipped.push({ file: rel, message: String((e as Error)?.message ?? e).split("\n")[0]! }); continue; }
    const internal = sourceAbs.some((d) => isInside(file, d)) && !NOT_INTERNAL.test(`/${rel.replace(/\\/g, "/")}`);
    const found: Use[] = [];
    for (const el of elements) for (const u of matchElement(el, index, (spec) => isSystemImport(spec, file))) found.push(internal ? { ...u, internal: true } : u);
    uses.push(...found.sort((a, b) => a.line - b.line)); // readers append macro calls after elements
  }
  return { system: config.system.name, sources, concepts, uses, files: { read: files.length, skipped } };
}

/** The system's own source folders: system.path, else workspaces named in system.packages, else the root package. */
export function systemSources(root: string, config: DsaConfig): string[] {
  const sys = config.system as DsaConfig["system"] & { path?: string };
  if (sys.path) return [sys.path];
  const names = new Set(config.system.packages);
  const dirs = discoverWorkspaces(root).filter((w) => names.has(w.name)).map((w) => path.relative(root, w.dir) || ".");
  if (dirs.length) return dirs;
  // Not declared as workspaces (Bazel, a single package, a folder of packages): find the package.json files.
  const found: string[] = [];
  for (const pjFile of fg.sync("**/package.json", { cwd: root, absolute: true, ignore: ["**/node_modules/**", "**/dist/**"], deep: 5 })) {
    try {
      if (names.has(JSON.parse(fs.readFileSync(pjFile, "utf8")).name)) found.push(path.relative(root, path.dirname(pjFile)) || ".");
    } catch { /* unreadable */ }
  }
  return found.sort();
}

// ---------- matching ----------

interface Index {
  byKey: Map<string, Concept>;
  tag: Map<string, string>; // exact tag (XBtn) and lowercase tag (x-btn, acme-button)
  symbol: Map<string, string>;
  selectors: { tag?: string | undefined; attribute: string; key: string }[];
  cls: Map<string, string>;
  macro: Map<string, string>;
}

function indexConcepts(concepts: Concept[]): Index {
  const ix: Index = { byKey: new Map(), tag: new Map(), symbol: new Map(), selectors: [], cls: new Map(), macro: new Map() };
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
// `[acTooltip]`, `(click)`, `[(value)]`, `:prop`, `v-bind:prop`, `bind:prop` all name the attribute `prop`.
const attrName = (n: string) => n.replace(/^\[\(|\)\]$/g, "").replace(/^[[(]|[\])]$/g, "").replace(/^(v-bind:|bind:|:)/, "");

export function matchElement(el: Element, ix: Index, isSystemImport: (spec: string) => boolean): Use[] {
  const out: Use[] = [];
  const add = (key: string | undefined, form: RealizationForm["form"], modifiers?: string[], part?: string) => {
    if (key && !out.some((u) => u.concept === key && u.part === part)) out.push({ concept: key, file: el.file, line: el.line, form, ...(part ? { part } : {}), ...(modifiers?.length ? { modifiers } : {}) });
  };
  if (el.macro) { add(ix.macro.get(el.tag), "macro"); return out; }

  const isComponentTag = /^[A-Z]/.test(el.tag) || el.tag.includes(".");
  if (isComponentTag) {
    if (el.importSource !== undefined) {
      if (isSystemImport(el.importSource)) {
        const [head, ...rest] = el.tag.split(".");
        const local = el.importedName && el.importedName !== "*" && el.importedName !== "default" ? el.importedName : head!;
        const member = rest.join("");
        const resolve = (n: string) => ix.symbol.get(n) ?? (ix.byKey.has(normKey(n)) ? normKey(n) : undefined);
        if (!member) add(resolve(local) ?? resolve(path.basename(el.importSource)), "import");
        else {
          // Dialog.Root → Dialog. Dialog.Content → DialogContent when the system exports that name;
          // otherwise a part of its parent (ActionMenu.Button is ActionMenu's button, not the system's Button).
          const parent = resolve(local);
          const combined = member === "Root" ? undefined : resolve(`${local}${member}`);
          if (member === "Root") add(parent, "import");
          else if (combined) add(combined, "import");
          else if (parent) add(parent, "import", undefined, member);
          else if (/^[a-z]/.test(head!) || el.importedName === "*") add(resolve(member), "import"); // import * as ui; <ui.Button>
        }
      }
    } else {
      // No import binding: a globally registered tag (Vue plugin, auto-import), or a docs example that
      // writes an exported component without its import (Markdown, MDX).
      add(ix.tag.get(el.tag) ?? ix.symbol.get(el.tag), ix.tag.has(el.tag) ? "tag" : "import");
    }
  } else if (el.tag.includes("-")) {
    add(ix.tag.get(el.tag.toLowerCase()), "tag");
  }

  if (ix.selectors.length) {
    const attrs = new Set(Object.keys(el.attributes).map(attrName));
    for (const s of ix.selectors) if ((!s.tag || s.tag === el.tag) && attrs.has(s.attribute)) add(s.key, "selector");
  }
  for (const c of el.classes) {
    const key = ix.cls.get(c);
    if (!key) continue;
    const mods = el.classes.filter((x) => x !== c && (x.startsWith(`${c}-`) || x.startsWith(`${c}__`))).map((x) => x.slice(c.length).replace(/^-+|^_+/, ""));
    add(key, "class", mods);
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
