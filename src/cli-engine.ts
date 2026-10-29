import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import type { CliIo } from "./cli.js";
import { loadAddons, runAfterHooks, type DsaAddon } from "./addons.js";
import { findConfigFile, CONFIG_FILENAME } from "./config.js";
import { loadEngineContext, requirePackages, type EngineContext } from "./engine/from-dsa.js";
import { APP_DIR, resolveHostRoot, targetRelative } from "./engine/paths.js";
import { runPipeline, reevaluateElements, type PipelineStage } from "./engine/pipeline.js";
import { hasStore, openStore, registerStore } from "./engine/store.js";
import { rowToFinding, snooze } from "./engine/evaluate.js";
import { githubHttp, pushedThisWeek, syncIssues, writeDrafts } from "./engine/issues.js";
import { discoverWorkspaces, resolveTargets } from "./engine/workspaces.js";
import { githubToken } from "./engine/secrets.js";
import { loadCatalog, withMetrics } from "./engine/catalog.js";
import { effectiveSettings, parseValue, setSetting } from "./engine/settings.js";
import { applyDecisionFile, decide, explain, latestEvals, planMarkdown, printElements, writePlan } from "./engine/review.js";
import { DEFAULT_THRESHOLD, type ElementEval } from "./engine/elements.js";
import { mapInstance } from "./engine/mapping.js";
import { useSystem } from "./engine/system.js";
import type { Finding } from "./engine/types.js";

export interface EngineGlobals {
  config?: string;
  root?: string;
  data?: string;
  profile?: string;
  json?: boolean;
}

/** Add-ons found for this invocation, loaded once. */
let addonsLoaded: { addons: DsaAddon[]; notes: string[] } | null = null;

/** Find and load installed add-ons, register a store if one offers it. */
export async function useAddons(cwd: string): Promise<{ addons: DsaAddon[]; notes: string[] }> {
  if (addonsLoaded) return addonsLoaded;
  const notes: string[] = [];
  const addons = await loadAddons([cwd, APP_DIR], notes);
  for (const a of addons) if (a.store) registerStore(a.store);
  addonsLoaded = { addons, notes };
  return addonsLoaded;
}

/** Forget loaded add-ons (tests). */
export function resetAddons(): void {
  addonsLoaded = null;
  registerStore(null);
}

/** Load config and profile from the CLI's global options, the way every engine command does. */
export async function engineContext(cwd: string, g: EngineGlobals): Promise<EngineContext> {
  return context({ cwd } as CliIo, g);
}

async function context(io: CliIo, g: EngineGlobals): Promise<EngineContext> {
  const o: Parameters<typeof loadEngineContext>[0] = { cwd: io.cwd };
  if (g.root) o.root = g.root;
  else if (!g.config && !findConfigFile(io.cwd)) o.root = resolveHostRoot(undefined, io.cwd);
  if (g.config) o.configPath = g.config;
  if (g.profile) o.profile = g.profile;
  if (g.data) o.dataDir = g.data;
  const ctx = await loadEngineContext(o);
  useSystem(ctx.profile, [ctx.config.designSystem.core, ...(ctx.config.designSystem.children ?? [])].flatMap((l) => l.packages));
  return ctx;
}

async function storeFor(io: CliIo, command: string) {
  await useAddons(io.cwd);
  if (!hasStore()) await openStore("", command); // throws the install hint
}

async function openFindings(dataDir: string, all = false): Promise<Finding[]> {
  const store = await openStore(dataDir, "findings");
  try {
    return (await store.all<any>(`select * from findings ${all ? "" : "where status <> 'resolved'"} order by score desc`)).map(rowToFinding);
  } finally {
    store.close();
  }
}

async function draftIssues(dataDir: string): Promise<number> {
  const open = (await openFindings(dataDir)).filter((f) => f.status === "open");
  const dir = path.join(dataDir, "issues");
  fs.rmSync(dir, { recursive: true, force: true });
  return writeDrafts(open, dir).length;
}

/** The engine commands: run history, findings, issues, element review. */
export function addEngineCommands(program: Command, io: CliIo): void {
  const g = (cmd: Command) => cmd.optsWithGlobals<EngineGlobals>();

  program
    .command("where")
    .description("show the repo, config, profile, data folder and add-ons a run would use")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      const { addons, notes } = await useAddons(io.cwd);
      io.out(
        [
          `Repo:     ${ctx.root}`,
          `Config:   ${ctx.loaded.configPath ?? '(none: run "dsa init")'}${ctx.loaded.migrated ? " (analytics-suite format, converted in memory)" : ""}`,
          `Profile:  ${ctx.profile.name}`,
          `Data:     ${ctx.dataDir}`,
          `dsa:      ${APP_DIR}`,
          `Add-ons:  ${addons.map((a) => a.name).join(", ") || "none"}`,
          ...notes.map((n) => `note: ${n}`),
        ].join("\n"),
      );
    });

  program
    .command("init")
    .description(`write a first ${CONFIG_FILENAME} from the repo's workspaces`)
    .action((_o: unknown, cmd: Command) => {
      const root = g(cmd).root ? path.resolve(io.cwd, g(cmd).root!) : resolveHostRoot(undefined, io.cwd);
      const target = path.join(root, CONFIG_FILENAME);
      if (fs.existsSync(target)) {
        io.out(`${target} already exists; not overwriting.`);
        return;
      }
      const ws = discoverWorkspaces(root);
      const names = new Set(ws.map((w) => w.name));
      // Guess: workspaces that other workspaces depend on and look like a design system.
      const dependedOn = new Map<string, number>();
      for (const w of ws) for (const d of Object.keys(w.deps)) if (names.has(d)) dependedOn.set(d, (dependedOn.get(d) ?? 0) + 1);
      const looksDs = (n: string) => /(design|ds-|-ds\b|\/ds\b|ui-kit|uikit|components|tokens)/i.test(n);
      const core = [...dependedOn.keys()].filter(looksDs);
      const cfg = {
        $schema: "https://raw.githubusercontent.com/snds/dsa/main/schema/config.json",
        system: { name: "Core", packages: core.length ? core : ["@your-org/your-design-system"], tagPrefixes: [] as string[], children: [] as unknown[] },
        correctUse: { deprecated: {} },
        github: {},
        modules: { figma: false },
      };
      fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n");
      io.out(`Wrote ${target}`);
      io.out(core.length ? `Guessed core packages: ${core.join(", ")}` : "Could not guess the core packages: edit system.packages.");
      io.out('Next: add child libraries, tag prefixes (e.g. "ds-") and github.defaultRepo, then run "dsa run".');
    });

  program
    .command("run")
    .description("scan, compute metrics, update findings and write issue drafts (needs @snds/dsa-history)")
    .option("--registry", "ask npm for latest versions of system packages not in this repo")
    .option("--remote", "scan targets that declare a git source from fresh clones, even if a local path exists")
    .option("--no-git", "ignore git history: every file counts as new code")
    .option("--no-readiness", "skip the profile's agent-readiness provider")
    .option("--no-drafts", "don't write issue drafts")
    .option("--now <iso>", "the run's timestamp (for reproducible runs)")
    .action(async (o: { registry?: boolean; remote?: boolean; git?: boolean; readiness?: boolean; drafts?: boolean; now?: string }, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      requirePackages(ctx);
      await storeFor(io, "run");
      const { addons, notes: addonNotes } = await useAddons(io.cwd);
      const stages: PipelineStage[] = addons.flatMap((a) => a.stages ?? []);
      for (const n of [...(ctx.loaded.migrated ? [`${ctx.loaded.configPath} is an analytics-suite config; read it converted. "dsa config migrate" writes the new format.`] : []), ...addonNotes]) io.out(`note: ${n}`);
      const res = await runPipeline({
        root: ctx.root,
        dataDir: ctx.dataDir,
        config: ctx.config,
        profile: ctx.profile,
        configDir: ctx.configDir,
        store: (d) => openStore(d),
        stages,
        stageOptions: o,
        registry: Boolean(o.registry),
        remote: Boolean(o.remote),
        git: o.git !== false,
        readiness: o.readiness !== false,
        ...(o.now ? { now: new Date(o.now) } : {}),
        log: (m) => io.out(m),
      });
      const s = res.summary;
      io.out(`\nRun ${res.runId}: ${s.opened.length} opened, ${s.reopened.length} reopened, ${s.updated.length} still open, ${s.held.length} held (hysteresis), ${s.resolved.length} resolved.`);
      for (const n of res.notes) io.out(`note: ${n}`);
      // Add-ons that act on a finished run: screenshots, the report.
      const after: string[] = [];
      await runAfterHooks(addons, { kind: "run", ctx, options: o, store: (d) => openStore(d), notes: after, log: (m) => io.out(m) });
      for (const n of after) io.out(`note: ${n}`);
      if (o.drafts !== false) io.out(`Issue drafts: ${await draftIssues(ctx.dataDir)} in ${path.join(ctx.dataDir, "issues")}`);
    });

  program
    .command("reevaluate")
    .description("re-score the latest run's element review with the current rules and page placement (no new run)")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      await storeFor(io, "reevaluate");
      await reevaluateElements({ root: ctx.root, dataDir: ctx.dataDir, config: ctx.config, profile: ctx.profile, configDir: ctx.configDir, store: (d) => openStore(d), log: (m) => io.out(m) });
      const { addons } = await useAddons(io.cwd);
      const notes: string[] = [];
      await runAfterHooks(addons, { kind: "reevaluate", ctx, options: _o as Record<string, unknown>, store: (d) => openStore(d), notes, log: (m) => io.out(m) });
      for (const n of notes) io.out(`note: ${n}`);
    });

  program
    .command("findings")
    .description("list open findings")
    .option("--all", "include resolved findings")
    .action(async (o: { all?: boolean }, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      await storeFor(io, "findings");
      const list = await openFindings(ctx.dataDir, Boolean(o.all));
      if (g(cmd).json) return io.out(JSON.stringify(list, null, 2));
      if (!list.length) return io.out("No open findings.");
      for (const f of list) io.out(`${f.id}  ${String(Math.round(f.score)).padStart(3)}  ${f.severity.padEnd(7)}  ${f.status.padEnd(8)}  ${f.owner.padEnd(28)}  ${f.title}`);
    });

  const issues = program.command("issues").description("GitHub issues for open findings");
  issues
    .command("draft")
    .description("write issue markdown for open findings to <data>/issues")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      await storeFor(io, "issues draft");
      io.out(`${await draftIssues(ctx.dataDir)} drafts in ${path.join(ctx.dataDir, "issues")}`);
    });
  issues
    .command("sync")
    .description("plan (or with --apply, make) GitHub issue create/update/close; needs GITHUB_TOKEN")
    .option("--apply", "make the changes")
    .option("--only <id>", "limit to one finding")
    .action(async (o: { apply?: boolean; only?: string }, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      await storeFor(io, "issues sync");
      const catalog = withMetrics(loadCatalog(), ctx.profile.metrics);
      const settings = effectiveSettings(catalog, ctx.config, ctx.dataDir);
      let all = await openFindings(ctx.dataDir, true);
      const pushed = new Set(pushedThisWeek(all, settings.weekly_queue_budget).map((f) => f.id));
      if (o.only) {
        all = all.filter((f) => f.id === o.only);
        pushed.add(o.only);
      }
      const token = githubToken(ctx.dataDir);
      if (!token) io.out("GITHUB_TOKEN not set: showing the plan without checking existing issues.");
      if (o.apply && !token) throw new Error("--apply needs GITHUB_TOKEN (a token with issues:write on the target repos).");
      const { actions, urls } = await syncIssues(all, pushed, ctx.config, token ? githubHttp(token) : null, Boolean(o.apply));
      for (const a of actions) io.out(`${o.apply ? "" : "[plan] "}${a.kind.padEnd(7)} ${a.id} ${a.repo ?? ""}${a.number ? "#" + a.number : ""} ${a.reason ?? a.title ?? ""}`);
      if (!actions.length) io.out("Nothing to change.");
      if (o.apply && urls.size) {
        const store = await openStore(ctx.dataDir, "issues sync");
        try {
          for (const [id, url] of urls) await store.exec("update findings set issue_url=$2 where id=$1", [id, url]);
        } finally {
          store.close();
        }
      }
      if (!o.apply && actions.some((a) => a.kind !== "skip")) io.out("\nDry run. Add --apply to make these changes.");
    });

  program
    .command("snooze")
    .argument("<id>", "finding id")
    .requiredOption("--reason <text>", "why, so the snooze can be reviewed later")
    .option("--days <n>", "how long", "30")
    .description("snooze a finding")
    .action(async (id: string, o: { reason: string; days: string }, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      await storeFor(io, "snooze");
      const store = await openStore(ctx.dataDir, "snooze");
      try {
        await snooze(store, id, Number(o.days), o.reason);
        io.out(`Snoozed ${id}.`);
      } finally {
        store.close();
      }
    });

  const settings = program.command("settings").description("show the effective rule settings");
  settings.action(async (_o: unknown, cmd: Command) => {
    const ctx = await context(io, g(cmd));
    io.out(JSON.stringify(effectiveSettings(withMetrics(loadCatalog(), ctx.profile.metrics), ctx.config, ctx.dataDir), null, 2));
  });
  settings
    .command("set")
    .argument("<key>")
    .argument("<value>")
    .option("--note <text>", "why it changed (logged)")
    .description("change a rule setting; logged, takes effect on the next run")
    .action(async (key: string, value: string, o: { note?: string }, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      await storeFor(io, "settings set");
      const store = await openStore(ctx.dataDir, "settings set");
      try {
        const r = await setSetting(store, withMetrics(loadCatalog(), ctx.profile.metrics), ctx.config, ctx.dataDir, key, parseValue(value), o.note ?? "");
        io.out(`${key}: ${JSON.stringify(r.old)} -> ${JSON.stringify(r.value)} (logged). Takes effect on the next run.`);
      } finally {
        store.close();
      }
    });

  program
    .command("elements")
    .description("element review: grouped recommendations with confidence")
    .option("--target <name>", "one app")
    .option("--list", "show each element's id")
    .option("--needs-human", "only those below the review threshold")
    .option("--patterns", "shared class constants and identical styles")
    .action(async (o: { target?: string; list?: boolean; needsHuman?: boolean; patterns?: boolean }, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      await storeFor(io, "elements");
      const { runId, evals } = await latestEvals(ctx.dataDir, o.target);
      if (!runId) return io.out('No runs yet. Run "dsa run" first.');
      printElements(evals, { list: Boolean(o.list), needsHuman: Boolean(o.needsHuman), json: Boolean(g(cmd).json), patterns: Boolean(o.patterns) });
    });

  program
    .command("signatures")
    .argument("[component]", "one component, as JSON")
    .description("component signatures (structure, props, tokens) read from the core source")
    .action(async (component: string | undefined, _o: unknown, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      const f = path.join(ctx.dataDir, "signatures.json");
      if (!fs.existsSync(f)) return io.out('No signatures yet. Run "dsa run" first.');
      const all = JSON.parse(fs.readFileSync(f, "utf8")) as any[];
      const pick = component ? all.filter((c) => c.component === component) : all;
      if (g(cmd).json || component) return io.out(JSON.stringify(pick, null, 2));
      for (const c of all)
        io.out(
          `${c.component.padEnd(28)} <${c.tag}${c.role ? ` role=${c.role}` : ""}>  ${c.from.padEnd(28)} ${
            Object.entries(c.axes as Record<string, unknown[]>)
              .map(([a, v]) => `${a}: ${v.length}`)
              .join(", ") || "no variants"
          }  ${c.childSlots.length ? "slots: " + c.childSlots.join(" ") : ""}`,
        );
    });

  program
    .command("explain")
    .argument("<id>", "an element id (E-…) or fingerprint")
    .description("the evidence behind one evaluation: rule, reasons, alternatives")
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      await storeFor(io, "explain");
      const { evals } = await latestEvals(ctx.dataDir);
      const e = evals.find((x) => x.id === id || x.fingerprint === id || x.id === `E-${id}`);
      if (!e) throw new Error(`No evaluation ${id} in the latest run.`);
      io.out(g(cmd).json ? JSON.stringify(e, null, 2) : explain(e));
    });

  program
    .command("decide")
    .argument("[id]", "an element id")
    .description("record a review decision in the app's decisions file (takes effect on the next run)")
    .option("--accept", "take the recommendation")
    .option("--keep", "keep the native element")
    .option("--gap [what]", "the system has no home for it")
    .option("--use <component>", "replace with this component")
    .option("--props <k=v,...>", "props for --use")
    .option("--from <source>", "import source for --use")
    .option("--by <who>", "human or agent", "human")
    .option("--who <name>", "who decided")
    .option("--note <text>", "why")
    .option("--pattern <key>", "decide every element styled by this shared class constant or style signature")
    .option("--file <decisions.json>", "apply decisions staged on the published dashboard")
    .action(async (id: string | undefined, o: Record<string, string | boolean>, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      await storeFor(io, "decide");
      if (typeof o.file === "string") {
        const applied = await applyDecisionFile(ctx.root, ctx.config, ctx.dataDir, path.resolve(io.cwd, o.file), typeof o.who === "string" ? o.who : undefined);
        for (const a of applied) io.out(`Recorded for ${a.elements} element(s): ${a.pattern ? `pattern ${a.pattern}` : `${a.ids?.length} id(s)`}`);
        io.out(`${applied.length} decision(s) applied. They take effect on the next run.`);
        return;
      }
      const r = await decide(ctx.root, ctx.config, ctx.dataDir, id ?? "", o);
      io.out(`Recorded for ${r.count} element(s) (${r.entry.by}${r.entry.agreed ? ", agrees with the recommendation" : ", overrides the recommendation"}) in ${r.file}. Takes effect on the next run.`);
    });

  program
    .command("plan")
    .description("migration plan: ready items, questions for a human, and system gaps")
    .option("--target <name>", "one app")
    .option("--out <file.md>", "where to write it (default <data>/plans/<target>.md)")
    .action(async (o: { target?: string; out?: string }, cmd: Command) => {
      const ctx = await context(io, g(cmd));
      await storeFor(io, "plan");
      const { evals } = await latestEvals(ctx.dataDir, o.target);
      const shots = shotIndex(ctx.dataDir);
      const all = resolveTargets(ctx.root, ctx.config);
      let sigs: any[] = [];
      try {
        sigs = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "signatures.json"), "utf8"));
      } catch {
        /* none */
      }
      const mapper = (e: ElementEval) => {
        const d = e.decided?.decision ?? e;
        if (d.verdict !== "replace") return null;
        const t = all.find((x) => x.name === e.target);
        const abs = [path.resolve(ctx.root, e.file), ...(t ? [path.join(t.dir, targetRelative(ctx.root, e.file, t.dir))] : [])].find((f) => fs.existsSync(f));
        return abs ? mapInstance(e, abs, t?.dir ?? ctx.root, d, sigs.find((c) => c.component === d.use)) : null;
      };
      const md = planMarkdown(evals, { ...(o.target ? { target: o.target } : {}), threshold: ctx.config.review?.threshold ?? DEFAULT_THRESHOLD, shots, mapper });
      const out = o.out ? path.resolve(io.cwd, o.out) : path.join(ctx.dataDir, "plans", `${(o.target ?? "all").replace(/[^\w.-]+/g, "-")}.md`);
      writePlan(out, md);
      io.out(`Wrote ${out}`);
    });

  void pc;
}

/** Screenshots the review add-on took, by element id. */
function shotIndex(dataDir: string): Map<string, string> {
  const f = path.join(dataDir, "shots", "index.json");
  if (!fs.existsSync(f)) return new Map();
  const idx = JSON.parse(fs.readFileSync(f, "utf8")) as { shots?: Record<string, { file: string }> };
  return new Map(Object.entries(idx.shots ?? {}).map(([id, s]) => [id, path.join(dataDir, "shots", s.file)]));
}

/** Let each installed add-on add its commands. */
export async function addAddonCommands(program: Command, io: CliIo): Promise<void> {
  const { addons } = await useAddons(io.cwd);
  const api = {
    cwd: io.cwd,
    out: io.out,
    err: io.err,
    context: (cmd: Command) => context(io, cmd.optsWithGlobals<EngineGlobals>()),
    addons: async () => (await useAddons(io.cwd)).addons,
    requireStore: (command: string) => storeFor(io, command),
  };
  for (const a of addons) a.commands?.(program, api);
}
