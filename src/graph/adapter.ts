import path from "node:path";
import type { DsaConfig } from "../config.js";
import type { FileGraph, Framework } from "./types.js";

/**
 * One reader per markup language. Every reader turns a file into the same
 * FileGraph, so adoption, patterns and the ratchet never care which language a
 * screen was written in. React (TSX/JSX) is built in; Vue and Angular readers
 * plug in here.
 */
export interface SourceAdapter {
  framework: Framework;
  /** Extensions this adapter claims, with the dot (".vue"). */
  extensions: string[];
  /** Called once per graph build; the reader may hold a parser across files. */
  createReader(ctx: ReaderContext): FileReader;
}

export interface ReaderContext {
  /** Absolute scan root. */
  root: string;
  config: DsaConfig;
  /** In-repo import prefixes (tsconfig paths, `@/`, `~/`, `#`). */
  prefixes: string[];
}

export interface FileReader {
  /** Read one absolute file path into its graph. */
  read(file: string): FileGraph;
  dispose?(): void;
}

/**
 * Pick the adapter for a file by extension. Files no adapter claims go to the
 * fallback (React), which is how every file was read before adapters existed.
 */
export function adapterFor(file: string, adapters: SourceAdapter[], fallback: SourceAdapter): SourceAdapter {
  const ext = path.extname(file).toLowerCase();
  return adapters.find((a) => a.extensions.includes(ext)) ?? fallback;
}
