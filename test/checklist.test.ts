import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checklistFromContext, ITEMS, AREAS, type ChecklistReport } from "../src/checklist/index.js";
import { createProgram, type CliIo } from "../src/cli.js";
import { createRunContext } from "../src/run.js";
import { ChecklistAnswersSchema, ChecklistReportSchema } from "../src/schema/index.js";
import { rmrf, tempFixture } from "./helpers.js";

let dir: string;

beforeEach(() => {
  dir = tempFixture();
});
afterEach(() => rmrf(dir));

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const checklist = (opts: Parameters<typeof checklistFromContext>[1] = {}): ChecklistReport => checklistFromContext(createRunContext({ cwd: dir }), opts);
const item = (r: ChecklistReport, id: string) => r.items.find((i) => i.id === id)!;

describe("checklist items", () => {
  it("has unique ids, each in a known area", () => {
    const ids = ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const areas = new Set(AREAS.map((a) => a.id));
    for (const i of ITEMS) expect(areas.has(i.area), i.id).toBe(true);
  });

  it("are all listed in docs/checklist.md, measured ones as measured", () => {
    const doc = fs.readFileSync(new URL("../docs/checklist.md", import.meta.url), "utf8");
    for (const i of ITEMS) {
      const row = doc.split("\n").find((l) => l.startsWith(`| \`${i.id}\` |`));
      expect(row, `${i.id} missing from docs/checklist.md`).toBeDefined();
      expect(row!.endsWith("no — the team answers |"), `${i.id}: doc says ${i.detect ? "unmeasured" : "measured"}`).toBe(!i.detect);
    }
  });
});

describe("dsa checklist", () => {
  it("scores every item and measures usage from the scan", () => {
    const r = checklist();
    expect(r.items).toHaveLength(ITEMS.length);
    expect(r.summary.measured).toBeGreaterThan(30);
    expect(r.summary.measured + r.summary.answered + r.summary.unanswered).toBe(r.items.length);
    const adoption = item(r, "usage.adoption");
    expect(adoption.source).toBe("measured");
    expect(adoption.evidence[0]).toMatch(/system and \d+ local component instances/);
    expect(item(r, "agents.rules").status).toBe("missing");
    // Items the scan never measures wait for the team.
    expect(item(r, "mobile.native")).toMatchObject({ status: "unanswered", source: "none" });
  });

  it("finds agent-readiness artifacts in the repo", () => {
    write("AGENTS.md", "# Agents\n");
    write(".agents/skills/use-ui/SKILL.md", "---\nname: use-ui\n---\n");
    write(".agents/skills/audit-tokens/SKILL.md", "---\nname: audit-tokens\n---\n");
    write(".mcp.json", JSON.stringify({ mcpServers: { storybook: { url: "http://localhost:6006/mcp" } } }));
    write("docs/public/llms.txt", "# UI\n");
    write("tokens/color.tokens.json", JSON.stringify({ color: { brand: { $value: "#0050ff", $type: "color" } } }));
    write("mcp/package.json", JSON.stringify({ name: "@fixture/ui-mcp", version: "1.0.0", dependencies: { "@modelcontextprotocol/server": "^2.0.0" } }));
    write(".github/workflows/ci.yml", "jobs:\n  ds:\n    steps:\n      - run: npx dsa ratchet\n");
    write(".dsa/baseline.json", "{}");
    const r = checklist();
    expect(item(r, "agents.rules").status).toBe("done");
    expect(item(r, "agents.skills")).toMatchObject({ status: "done", evidence: [".agents/skills/audit-tokens", ".agents/skills/use-ui"] });
    expect(item(r, "agents.toolAccess").evidence).toContain("servers: storybook");
    expect(item(r, "agents.llms").status).toBe("done");
    expect(item(r, "agents.tokenFile").evidence).toEqual(["tokens/color.tokens.json"]);
    expect(item(r, "agents.mcp").evidence).toEqual(["@fixture/ui-mcp"]);
    expect(item(r, "usage.ratchet").status).toBe("done");
    expect(item(r, "testing.ci").status).toBe("done");
  });

  it("applies the team's answers and keeps what the scan found when one overrides it", () => {
    write("dsa.checklist.json", JSON.stringify({ items: { "mobile.native": { status: "na" }, "patterns.forms": { status: "partial", note: "forms guide in progress" }, "agents.rules": { status: "done", note: "rules live in the docs repo" }, "nope.item": { status: "done" } } }));
    const r = checklist();
    expect(r.answersPath).toBe(path.join(dir, "dsa.checklist.json"));
    expect(item(r, "mobile.native")).toMatchObject({ status: "na", source: "answered" });
    expect(item(r, "patterns.forms")).toMatchObject({ status: "partial", source: "answered", evidence: ["forms guide in progress"] });
    const rules = item(r, "agents.rules");
    expect(rules).toMatchObject({ status: "done", source: "overridden" });
    expect(rules.measured?.status).toBe("missing");
    expect(r.unknownAnswers).toEqual(["nope.item"]);
    // n/a leaves the area's denominator.
    const mobile = r.areas.find((a) => a.id === "mobile")!;
    expect(mobile).toMatchObject({ applicable: 0, unanswered: 1, score: null });
  });

  it("refuses an answer without a valid status", () => {
    write("dsa.checklist.json", JSON.stringify({ items: { "mobile.native": { status: "yes" } } }));
    expect(() => checklist()).toThrow(/needs a status of done, partial, missing or na/);
  });

  it("scores partial as half", () => {
    const r = checklist();
    for (const a of r.areas) {
      if (!a.applicable) continue;
      expect(a.score).toBeCloseTo((a.done + a.partial / 2) / a.applicable, 3);
    }
  });

  it("leaves system-side items to the team in a repo that only consumes the system", () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-consumer-"));
    try {
      fs.writeFileSync(path.join(app, "dsa.config.json"), JSON.stringify({ system: { name: "x", packages: ["@x/ui"] }, scan: { include: ["src/**/*.tsx"] } }));
      fs.mkdirSync(path.join(app, "src"));
      fs.writeFileSync(path.join(app, "src/page.tsx"), 'import { Button } from "@x/ui";\nexport const Page = () => <div><Button>Save</Button><button>Cancel</button></div>;\n');
      const r = checklistFromContext(createRunContext({ cwd: app }));
      expect(item(r, "tokens.semantic").status).toBe("unanswered");
      expect(item(r, "components.foundation").status).toBe("unanswered");
      expect(item(r, "usage.adoption").source).toBe("measured");
    } finally {
      rmrf(app);
    }
  });
});

describe("dsa checklist (cli)", () => {
  let out: string[];
  let io: CliIo;
  beforeEach(() => {
    out = [];
    io = { out: (s) => out.push(s), err: () => {}, cwd: dir };
  });
  const run = (...args: string[]) => createProgram(io).parseAsync(["node", "dsa", ...args]);

  it("writes checklist.json and, with --markdown, a page to share", async () => {
    await run("checklist", ".", "--markdown");
    expect(fs.existsSync(path.join(dir, ".dsa/checklist.json"))).toBe(true);
    const md = fs.readFileSync(path.join(dir, ".dsa/checklist.md"), "utf8");
    expect(md).toMatch(/^# Design system checklist — fixture/);
    expect(md).toMatch(/## Agent readiness — \d+%/);
    expect(md).toMatch(/`agents\.mcp`/);
    const text = out.join("\n");
    expect(text).toMatch(/dsa checklist — fixture — \d+% of applicable items/);
    expect(text).toMatch(/Agent readiness/);
  });

  it("--json prints the report", async () => {
    await run("--json", "checklist");
    const json = JSON.parse(out.join("\n")) as ChecklistReport;
    expect(json.items).toHaveLength(ITEMS.length);
    expect(() => ChecklistReportSchema.parse(json)).not.toThrow();
    expect(() => ChecklistAnswersSchema.parse({ items: { "agents.genUi": { status: "na" } } })).not.toThrow();
    expect(fs.existsSync(path.join(dir, ".dsa/checklist.json"))).toBe(false);
  });
});
