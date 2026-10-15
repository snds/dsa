import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { SourceFile } from "ts-morph";
import type { DsaConfig } from "../config.js";
import type { ElementKind, ImportBinding } from "./types.js";

/** `spec` is `entry` itself or a subpath of it (`@acme/ui`, `@acme/ui/button`). */
export function matchesSource(spec: string, entry: string): boolean {
  return spec === entry || spec.startsWith(entry.endsWith("/") ? entry : `${entry}/`);
}

const COMMON_LOCAL_PREFIXES = ["@/", "~/", "#", "src/", "/"];

/**
 * Prefixes that mean "inside this repository": relative paths, the usual
 * aliases, and any `paths` keys from the root tsconfig.
 */
export function localPrefixes(root: string): string[] {
  const prefixes = [...COMMON_LOCAL_PREFIXES];
  for (const key of Object.keys(tsconfigPaths(root))) {
    const prefix = key.replace(/\*$/, "");
    if (prefix && !prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}

function tsconfigPaths(root: string): Record<string, string[]> {
  try {
    const text = fs.readFileSync(path.join(root, "tsconfig.json"), "utf8");
    const json = JSON.parse(stripJsonComments(text)) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    const baseUrl = json.compilerOptions?.baseUrl ?? ".";
    const out: Record<string, string[]> = {};
    for (const [key, targets] of Object.entries(json.compilerOptions?.paths ?? {})) {
      out[key] = targets.map((t) => path.resolve(root, baseUrl, t));
    }
    return out;
  } catch {
    // No tsconfig, or one we cannot parse: callers fall back to the common prefixes.
    return {};
  }
}

/**
 * Absolute directories that hold the design system's own source, so those
 * files can be parsed for names but kept out of adoption and pattern counts.
 * Local aliases resolve through tsconfig `paths`; packages resolve through the
 * `name` of workspace package.json files (three levels deep at most).
 */
export function dsSourceDirs(root: string, config: DsaConfig): string[] {
  const dirs = new Set<string>();
  const paths = tsconfigPaths(root);
  for (const alias of config.system.localAliases) {
    for (const [key, targets] of Object.entries(paths)) {
      const prefix = key.replace(/\*$/, "");
      if (!key.endsWith("*") || !alias.startsWith(prefix)) continue;
      const rest = alias.slice(prefix.length);
      for (const t of targets) dirs.add(t.replace(/\*$/, "") + rest);
    }
    // No tsconfig mapping: try the alias as a path with its leading marker removed.
    if (dirs.size === 0 && /^[@~]\//.test(alias)) {
      for (const base of ["src", "."]) {
        const guess = path.resolve(root, base, alias.slice(2));
        if (fs.existsSync(guess)) dirs.add(guess);
      }
    }
  }
  if (config.system.packages.length > 0) {
    const manifests = fg.sync(["*/package.json", "*/*/package.json", "*/*/*/package.json"], {
      cwd: root,
      ignore: ["**/node_modules/**"],
      absolute: true,
    });
    for (const m of manifests) {
      try {
        const name = (JSON.parse(fs.readFileSync(m, "utf8")) as { name?: string }).name;
        if (name && config.system.packages.includes(name)) dirs.add(path.dirname(m));
      } catch {
        // Unreadable manifest: not a DS package we can place.
      }
    }
  }
  return [...dirs].map((d) => path.resolve(d));
}

export function isUnder(file: string, dirs: string[]): boolean {
  return dirs.some((d) => file === d || file.startsWith(d + path.sep));
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1");
}

export function classifySource(spec: string, config: DsaConfig, localPrefixList: string[]): ElementKind {
  if (config.system.packages.some((p) => matchesSource(spec, p))) return "ds";
  if (config.system.localAliases.some((a) => matchesSource(spec, a))) return "ds";
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") return "local";
  if (localPrefixList.some((p) => spec.startsWith(p))) return "local";
  return "external";
}

/** Collect every import binding in a file with the element kind its source implies. */
export function collectImports(sf: SourceFile, config: DsaConfig, localPrefixList: string[]): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const decl of sf.getImportDeclarations()) {
    const source = decl.getModuleSpecifierValue();
    const kind = classifySource(source, config, localPrefixList);
    const def = decl.getDefaultImport();
    if (def) bindings.push({ local: def.getText(), source, kind });
    const ns = decl.getNamespaceImport();
    if (ns) bindings.push({ local: ns.getText(), source, kind });
    for (const named of decl.getNamedImports()) {
      const alias = named.getAliasNode();
      bindings.push({ local: alias ? alias.getText() : named.getName(), source, kind });
    }
  }
  return bindings;
}

export interface Resolver {
  resolve(tagName: string): { kind: ElementKind; source: string | null };
}

export function createResolver(imports: ImportBinding[], declaredNames: Set<string>): Resolver {
  const byLocal = new Map(imports.map((b) => [b.local, b]));
  return {
    resolve(tagName) {
      const rootIdent = tagName.split(".")[0] ?? tagName;
      const first = rootIdent.charAt(0);
      // Intrinsic elements are lowercase and never dotted (`div`, `svg`, `input`).
      if (!tagName.includes(".") && first === first.toLowerCase() && first !== first.toUpperCase()) {
        return { kind: "html", source: null };
      }
      const binding = byLocal.get(rootIdent);
      if (binding) return { kind: binding.kind, source: binding.source };
      if (declaredNames.has(rootIdent)) return { kind: "local", source: null };
      return { kind: "external", source: null };
    },
  };
}
