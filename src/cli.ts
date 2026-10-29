#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import { ignoreCandidate, loadDecisions, saveDecisions } from "./detect/decisions.js";
import { decisionsPath, patternsFromContext } from "./patterns.js";
import { ratchetFromContext } from "./ratchet.js";
import { formatPatterns, formatRatchet, formatScan } from "./report/text.js";
import { loadRunContext, writeJson, type RunOptions } from "./run.js";
import { isSuiteConfig, migrateSuiteConfig } from "./migrate.js";
import { scanFromContext } from "./scan.js";
import { dsaVersion } from "./version.js";

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
}

interface GlobalOpts {
  json?: boolean;
  config?: string;
}

function runOptions(dir: string | undefined, opts: GlobalOpts, io: CliIo): RunOptions {
  const o: RunOptions = { cwd: io.cwd };
  if (dir) o.dir = dir;
  if (opts.config) o.configPath = opts.config;
  return o;
}

function emit(io: CliIo, json: boolean | undefined, file: string, data: unknown, text: string): void {
  if (json) {
    io.out(JSON.stringify(data, null, 2));
    return;
  }
  writeJson(file, data);
  io.out(text);
  io.out("");
  io.out(pc.dim(`wrote ${file}`));
}

/** Build the commander program; `io` is injectable so tests can capture output. */
export function createProgram(io: CliIo = { out: console.log, err: console.error, cwd: process.cwd() }): Command {
  const program = new Command();
  program
    .name("dsa")
    .description("Design-system analytics: inventory, adoption, pattern candidates and a correct-use ratchet.")
    .version(dsaVersion())
    .option("--json", "print the JSON report to stdout instead of writing it to the output directory")
    .option("--config <path>", "path to dsa.config.json (default: discovered upward from the scanned directory)")
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) });

  program
    .command("scan")
    .argument("[dir]", "directory to scan", ".")
    .description("component inventory + adoption + correct-use metrics -> <output.dir>/scan.json")
    .action(async (dir: string, _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      const ctx = await loadRunContext(runOptions(dir, g, io));
      const report = scanFromContext(ctx);
      emit(io, g.json, path.join(ctx.outputDir, "scan.json"), report, formatScan(report));
    });

  program
    .command("patterns")
    .argument("[dir]", "directory to scan", ".")
    .option("--all", "include snowflakes (compositions below the occurrence / host bar)")
    .option("--ignore <id>", "record that a reviewer ignored this candidate; parked after patterns.ignoreIgnoredTimes")
    .description("pattern-candidate suggestion records -> <output.dir>/patterns.json")
    .action(async (dir: string, opts: { all?: boolean; ignore?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      const ctx = await loadRunContext(runOptions(dir, g, io));
      const decisions = loadDecisions(decisionsPath(ctx));
      if (opts.ignore) {
        const probe = patternsFromContext(ctx, { all: true, decisions: { version: 1, decisions: {} } });
        const target = probe.candidates.find((c) => c.id === opts.ignore);
        if (!target) throw new Error(`No candidate with id ${opts.ignore}.`);
        const d = ignoreCandidate(decisions, target.id, ctx.loaded.config.patterns.ignoreIgnoredTimes, target.name);
        saveDecisions(decisionsPath(ctx), decisions);
        io.err(`${target.name} [${target.id}] ignored ${d.ignoredTimes}x -> ${d.status}`);
      }
      const extra: Parameters<typeof patternsFromContext>[1] = { decisions };
      if (opts.all) extra.all = true;
      const report = patternsFromContext(ctx, extra);
      emit(io, g.json, path.join(ctx.outputDir, "patterns.json"), report, formatPatterns(report));
    });

  program
    .command("ratchet")
    .argument("[dir]", "directory to scan", ".")
    .option("--init", "create the baseline from the current counts")
    .option("--update", "rewrite the baseline with the current counts")
    .description("compare correct-use violation counts against ratchet.baseline; exit 1 if any grew")
    .action(async (dir: string, opts: { init?: boolean; update?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      const ctx = await loadRunContext(runOptions(dir, g, io));
      const extra: Parameters<typeof ratchetFromContext>[1] = {};
      if (opts.init) extra.init = true;
      if (opts.update) extra.update = true;
      const report = ratchetFromContext(ctx, extra);
      emit(io, g.json, path.join(ctx.outputDir, "ratchet.json"), report, formatRatchet(report));
      if (!report.ok) process.exitCode = 1;
    });

  const config = program.command("config").description("work with dsa.config.json");
  config
    .command("migrate")
    .argument("<file>", "a config written for the earlier analytics suite")
    .option("--profile <spec>", "set `profile` in the output (a path relative to the new config, or a package name)")
    .option("--write <path>", "write the converted config here instead of printing it")
    .option("--force", "overwrite --write's file if it exists")
    .description("convert an analytics-suite config to this format; lists every key that moved or was left out")
    .action((file: string, opts: { profile?: string; write?: string; force?: boolean }) => {
      const src = path.resolve(io.cwd, file);
      const raw = JSON.parse(fs.readFileSync(src, "utf8")) as unknown;
      if (!isSuiteConfig(raw)) throw new Error(`${file} has no "designSystem" section, so it isn't a suite config.`);
      const result = migrateSuiteConfig(raw, opts.profile ? { profile: opts.profile } : {});
      const json = JSON.stringify(result.config, null, 2) + "\n";
      const summary = [
        pc.bold(`dsa config migrate — ${result.moved.length} keys moved, ${result.dropped.length} left out`),
        ...result.moved.map((m) => `  ${m}`),
        ...(result.dropped.length ? ["", pc.yellow("left out (no home in dsa):"), ...result.dropped.map((d) => `  ${d}`)] : []),
        ...(result.notes.length ? ["", "notes:", ...result.notes.map((n) => `  ${n}`)] : []),
      ];
      if (!opts.write) {
        io.out(json.trimEnd());
        io.err(summary.join("\n"));
        return;
      }
      const dest = path.resolve(io.cwd, opts.write);
      if (fs.existsSync(dest) && !opts.force) throw new Error(`${dest} exists; pass --force to overwrite it.`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, json);
      io.out(summary.join("\n"));
      io.out("");
      io.out(pc.dim(`wrote ${dest}`));
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    // commander's exitOverride throws for --help / --version too; those are not failures.
    const e = err as { code?: string; exitCode?: number; message?: string };
    if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help") return;
    if (typeof e.exitCode === "number" && e.code?.startsWith("commander.")) {
      process.exitCode = e.exitCode;
      return;
    }
    console.error(pc.red(`dsa: ${e.message ?? String(err)}`));
    process.exitCode = 1;
  }
}

// Resolve symlinks: pnpm runs the bin through node_modules/.bin/dsa -> dist/cli.js.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(entry))).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) void main();
