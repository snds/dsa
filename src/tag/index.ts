import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';

/**
 * Source tags: each host JSX element (`button`, `input`, `a`…) gets `data-dsa-src="<file>:<line>:<col>"`, the
 * place the scanner records for it, so the crawler matches the element on the page exactly instead of
 * guessing from its tag, classes and words. The file is relative to the scan root, the way the scanner
 * stores it: never an absolute path, and nothing outside the repo is tagged.
 *
 * Off unless `when` is true or DSA_TAG=1, so a production build is never tagged by accident. Tags show
 * file paths in the build's DOM: use them on internal dev or preview builds only.
 *
 *   import { dsaTag } from '@snds/dsa/tag';
 *   export default defineConfig({ plugins: [dsaTag({ when: process.env.DSA_TAG === '1' }), react()] });
 *
 * Babel (and Next.js through Babel): `plugins: ['@snds/dsa/tag/babel']`.
 */
export interface TagOptions {
  /** Tag this build. Default: DSA_TAG=1 in the environment. */
  when?: boolean | undefined;
  /** The scan root (the folder with dsa.config.json). Default: DSA_TAG_ROOT, else the nearest folder up with dsa.config.json, else the git root. */
  root?: string | undefined;
  /** The app's own folder, when it sits outside the scan root (the scanner shows those files as "<folder>/<path>"). Default: DSA_TAG_DIR. */
  dir?: string | undefined;
  /**
   * Also tag component elements. Only for components that pass unknown props through to the DOM: a
   * component that doesn't gets a prop it ignores (or warns about). True for all, or a list of names.
   */
  components?: boolean | string[] | undefined;
}

export const TAG_ATTR = 'data-dsa-src';

/** Is tagging on for these options? */
export function tagEnabled(o: TagOptions = {}): boolean {
  return o.when ?? process.env.DSA_TAG === '1';
}

const roots = new Map<string, string | null>();
/** The nearest folder up from `dir` holding dsa.config.json, else the nearest git root. */
function findRoot(dir: string): string | null {
  if (roots.has(dir)) return roots.get(dir)!;
  let git: string | null = null;
  let found: string | null = null;
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'dsa.config.json'))) { found = d; break; }
    if (!git && fs.existsSync(path.join(d, '.git'))) git = d;
    if (path.dirname(d) === d) break;
  }
  const r = found ?? git;
  roots.set(dir, r);
  return r;
}

/**
 * A file's tag path, as the scanner shows it: relative to the root, with forward slashes. A file in an app
 * folder outside the root reads "<folder>/<path>". Null for anything else outside, and for node_modules.
 */
export function tagPath(file: string, root: string, dir?: string): string | null {
  const abs = path.resolve(file);
  if (abs.split(path.sep).includes('node_modules')) return null;
  const rel = path.relative(root, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  if (!dir) return null;
  const inDir = path.relative(dir, abs);
  if (!inDir || inDir.startsWith('..') || path.isAbsolute(inDir)) return null;
  return path.join(path.basename(dir), inDir).split(path.sep).join('/');
}

/** A file's tag path under these options (root and app folder from the options, the environment, or found). */
export function tagFileOf(file: string, o: TagOptions = {}): string | null {
  const root = o.root ?? process.env.DSA_TAG_ROOT ?? findRoot(path.dirname(path.resolve(file)));
  return root ? tagPath(file, root, o.dir ?? process.env.DSA_TAG_DIR) : null;
}

const SOURCE = /\.(jsx|tsx|js|mjs|cjs|mts|cts)$/;
const FRAGMENT = /(^|\.)Fragment$/;

/** One element the tagger stamped. */
export interface Tag { element: string; value: string; line: number; col: number }

/**
 * Tag one file's source. Null when there's nothing to do (tagging off, not a JSX file, outside the root,
 * no JSX, or it doesn't parse). Lines are kept: every tag is inserted on its element's own line.
 */
export function tagSource(code: string, file: string, o: TagOptions = {}): { code: string; tags: Tag[] } | null {
  if (!tagEnabled(o)) return null;
  const clean = file.replace(/[?#].*$/, '');
  if (!SOURCE.test(clean) || !code.includes('<')) return null;
  const rel = tagFileOf(clean, o);
  if (!rel) return null;
  let ast: any;
  // The scanner's own parser options, so lines and columns are the ones it records.
  try { ast = babelParse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript', 'decorators-legacy'] }); } catch { return null; }
  const comps = o.components;
  const edits: { at: number; text: string }[] = [];
  const tags: Tag[] = [];
  walk(ast.program, (n) => {
    if (n.type !== 'JSXOpeningElement' || !n.loc) return;
    const name = jsxName(n.name);
    if (!name) return;
    const host = n.name.type === 'JSXIdentifier' && /^[a-z]/.test(name) && !name.includes('-');
    if (!host && !(comps === true ? !FRAGMENT.test(name) : Array.isArray(comps) && comps.includes(name))) return;
    if (n.attributes.some((a: any) => a.type === 'JSXAttribute' && a.name?.name === TAG_ATTR)) return;
    const line = n.loc.start.line, col = n.loc.start.column + 1;
    const value = `${rel}:${line}:${col}`;
    // Straight after the name: before any spread, so a tag passed in from a caller still wins.
    edits.push({ at: n.name.end, text: ` ${TAG_ATTR}=${JSON.stringify(value)}` });
    tags.push({ element: name, value, line, col });
  });
  if (!edits.length) return null;
  let out = code;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return { code: out, tags };
}

const jsxName = (n: any): string | null => n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? (jsxName(n.object) ? `${jsxName(n.object)}.${n.property.name}` : null) : null;

function walk(node: any, fn: (n: any) => void) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key.endsWith('Comments') || key === 'extra') continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walk(c, fn);
    else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, fn);
  }
}

/**
 * The Vite plugin (Vite, React Router v7, Remix on Vite). Runs before other plugins, on the source as
 * written, so its lines and columns are the scanner's. Does nothing unless tagging is on.
 */
export function dsaTag(o: TagOptions = {}): { name: string; enforce: 'pre'; transform: (code: string, id: string) => { code: string; map: null } | null } {
  const on = tagEnabled(o);
  return {
    name: 'dsa:tag',
    enforce: 'pre',
    transform(code, id) {
      if (!on || id.startsWith('\0')) return null;
      const r = tagSource(code, id, { ...o, when: true });
      return r ? { code: r.code, map: null } : null;
    },
  };
}

export default dsaTag;
