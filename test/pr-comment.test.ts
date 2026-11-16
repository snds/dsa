import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgram, type CliIo } from "../src/cli.js";
import { githubHost } from "../src/deploy/adapters/github.js";
import type { HostContext } from "../src/deploy/types.js";
import type { ViolationCounts } from "../src/metrics/adoption.js";
import { styleValuesInText } from "../src/metrics/style-values.js";
import { PR_COMMENT_MARKER, compareScans, prCommentMarkdown, pullRequestFromEnv, type ComparableScan } from "../src/pr-comment.js";
import { scan } from "../src/scan.js";
import { ScanReportSchema } from "../src/schema/index.js";
import { rmrf, tempFixture } from "./helpers.js";

const counts = (c: Partial<ViolationCounts> = {}): ViolationCounts => ({ classNameOverrides: 0, styleOverrides: 0, spreadProps: 0, lookAlikes: 0, rawElements: 0, ...c });

/** A small scan, enough for the comparison: the base of a pull request. */
const base: ComparableScan = {
  correctUse: {
    overrides: [{ file: "src/screens/inbox.tsx", line: 12, column: 5, component: "Button", prop: "style" }],
    spreadProps: [],
    lookAlikes: [],
    rawElements: [{ file: "src/screens/settings.tsx", line: 30, column: 7, element: "button" }],
    counts: counts({ styleOverrides: 1, rawElements: 1 }),
  },
  styleValues: [
    { file: "src/screens/inbox.tsx", line: 40, column: 20, value: "#ffffff", kind: "color" },
    { file: "src/theme.css", line: 3, column: 12, value: "16px", kind: "length" },
  ],
};

/** Its head: one colour and one size added, a look-alike and a className override added, a raw button fixed, lines moved. */
const head: ComparableScan = {
  correctUse: {
    overrides: [
      { file: "src/screens/inbox.tsx", line: 14, column: 5, component: "Button", prop: "style" },
      { file: "src/screens/inbox.tsx", line: 22, column: 5, component: "Card", prop: "className" },
    ],
    spreadProps: [],
    lookAlikes: [{ name: "FancyButton", dsComponent: "Button", score: 0.9, declaredIn: { file: "src/components/FancyButton.tsx", line: 3, column: 1 }, usages: 2 }],
    rawElements: [],
    counts: counts({ styleOverrides: 1, classNameOverrides: 1, lookAlikes: 1 }),
  },
  styleValues: [
    { file: "src/screens/inbox.tsx", line: 42, column: 20, value: "#ffffff", kind: "color" },
    { file: "src/screens/inbox.tsx", line: 50, column: 18, value: "#3b82f6", kind: "color" },
    { file: "src/theme.css", line: 3, column: 12, value: "16px", kind: "length" },
    { file: "src/theme.css", line: 9, column: 12, value: "16px", kind: "length" },
  ],
};

describe("compareScans", () => {
  it("lists what the head adds and what it fixes, not what only moved", () => {
    const d = compareScans(base, head);
    expect(d.added.map((i) => `${i.category} ${i.file}:${i.line}`)).toEqual([
      "lookAlike src/components/FancyButton.tsx:3",
      "guidelines src/screens/inbox.tsx:22",
      "hardCoded src/screens/inbox.tsx:50",
      "hardCoded src/theme.css:9",
    ]);
    expect(d.removed.map((i) => `${i.category} ${i.file}:${i.line}`)).toEqual(["lookAlike src/screens/settings.tsx:30"]);
    // Counts are compared the ratchet's way.
    expect(d.counts.grew).toEqual(["classNameOverrides", "lookAlikes"]);
    expect(d.counts.shrank).toEqual(["rawElements"]);
    expect(d.styleValues).toEqual({ before: 2, after: 4 });
  });

  it("is clean when nothing changed", () => {
    const d = compareScans(base, base);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(prCommentMarkdown(d)).toBe(`${PR_COMMENT_MARKER}\n**Design system:** no change to design-system use.\n`);
  });
});

describe("prCommentMarkdown", () => {
  it("leads with the headline and names each file and line", () => {
    const md = prCommentMarkdown(compareScans(base, head), {
      baseLabel: "main (1a2b3c4)",
      link: (file, line) => `https://example.test/blob/abc/${file}#L${line}`,
    });
    expect(md).toMatchInlineSnapshot(`
      "<!-- dsa:pr-comment -->
      **Design system:** this change adds 4 problems and fixes 1.

      hard-coded style values: 2 · custom look-alikes: 1 · components used against their guidelines: 1

      **New hard-coded style values (2).** Use a design token instead.
      - [\`src/screens/inbox.tsx:50\`](https://example.test/blob/abc/src/screens/inbox.tsx#L50) hard-coded colour \`#3b82f6\`
      - [\`src/theme.css:9\`](https://example.test/blob/abc/src/theme.css#L9) hard-coded size \`16px\`

      **New custom look-alikes (1).** Use the system component instead.
      - [\`src/components/FancyButton.tsx:3\`](https://example.test/blob/abc/src/components/FancyButton.tsx#L3) \`FancyButton\` is a custom version of the system's \`Button\`

      **Components used against their guidelines (1).** Use the component's own props and variants.
      - [\`src/screens/inbox.tsx:22\`](https://example.test/blob/abc/src/screens/inbox.tsx#L22) \`Card\` is given its own \`className\`, which changes its look

      **Improvements (1).** Thank you.
      - [\`src/screens/settings.tsx:30\`](https://example.test/blob/abc/src/screens/settings.tsx#L30) removed plain \`<button>\` where the system has a component

      <sub>dsa compared this pull request with main (1a2b3c4). Totals: className overrides 0 → 1, custom look-alikes 0 → 1, plain HTML controls 1 → 0, hard-coded style values 2 → 4.</sub>
      "
    `);
  });

  it("says when a change only fixes things, and caps long lists", () => {
    const fixedOnly: ComparableScan = { ...base, correctUse: { ...base.correctUse, rawElements: [], counts: counts({ styleOverrides: 1 }) } };
    const md = prCommentMarkdown(compareScans(head, fixedOnly), { limit: 1 });
    expect(md.split("\n")[1]).toBe("**Design system:** this change fixes 4 problems and adds none.");
    expect(md).toContain("- …and 3 more.");
  });
});

describe("styleValuesInText", () => {
  it("finds colours and sizes in style contexts, by line, and leaves tokens alone", () => {
    const css = [":root {", "  --brand: #0af;", "}", ".card {", "  color: #333;", "  padding: 12px 0;", "  margin: 0;", "  width: 300px;", "  background: var(--brand);", "}", "#main { gap: 8px }"].join("\n");
    expect(styleValuesInText("a.css", css).map((v) => `${v.line}:${v.column} ${v.value}`)).toEqual(["5:10 #333", "6:12 12px", "11:14 8px"]);

    const tsx = [
      'const tint = "#ff0000";',
      "const label = \"#hashtag\";",
      '<div style={{ marginTop: 8, color: "red", width: 40 }} />',
      '<p className="bg-[#123456] p-[13px] text-sm" />',
      "const Box = styled.div`",
      "  border-radius: 4px;",
      "  color: rgb(0, 0, 0);",
      "`;",
      "// const old = \"#abcdef\";",
    ].join("\n");
    expect(styleValuesInText("a.tsx", tsx).map((v) => `${v.line} ${v.kind} ${v.value}`)).toEqual([
      "1 color #ff0000",
      "3 length 8",
      "4 color #123456",
      "4 length 13px",
      "6 length 4px",
      "7 color rgb(0, 0, 0)",
    ]);

    const vue = ['<template><div style="color: #fff; padding: 4px">x</div></template>', "<style>", ".a { color: #000 }", "</style>"].join("\n");
    expect(styleValuesInText("a.vue", vue).map((v) => `${v.line} ${v.value}`)).toEqual(["1 #fff", "1 4px", "3 #000"]);
  });

  it("is part of the scan report", () => {
    const dir = tempFixture();
    try {
      fs.writeFileSync(path.join(dir, "src/screens/theme.css"), ".x {\n  color: #123456;\n}\n");
      const r = scan({ dir });
      expect(r.styleValues).toContainEqual({ file: "src/screens/theme.css", line: 2, column: 10, value: "#123456", kind: "color" });
      expect(r.styleValues.find((v) => v.file === "src/screens/landing.tsx")).toMatchObject({ value: "8", kind: "length" });
      expect(ScanReportSchema.safeParse(r).success).toBe(true);
    } finally {
      rmrf(dir);
    }
  });
});

describe("pullRequestFromEnv", () => {
  it("reads the pull request from the Actions event file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-event-"));
    try {
      const file = path.join(dir, "event.json");
      fs.writeFileSync(file, JSON.stringify({ number: 7, pull_request: { number: 7, base: { sha: "b".repeat(40), ref: "main" }, head: { sha: "h".repeat(40) } } }));
      expect(pullRequestFromEnv({ GITHUB_EVENT_PATH: file, GITHUB_REPOSITORY: "owner/repo" })).toMatchObject({ number: 7, repo: "owner/repo", baseSha: "b".repeat(40), baseRef: "main" });
      expect(pullRequestFromEnv({})).toMatchObject({ number: undefined, repo: undefined });
    } finally {
      rmrf(dir);
    }
  });
});

/** A fetch that answers like the GitHub API and records every call. */
function fakeGitHub(existing: { id: number; body: string }[]) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const comments = [...existing];
  const fake = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (method === "GET" && /\/issues\/7\/comments/.test(url)) return json(200, comments.map((c) => ({ ...c, html_url: `https://github.com/o/r/pull/7#issuecomment-${c.id}` })));
    if (method === "PATCH") return json(200, { id: Number(url.split("/").pop()), html_url: `https://github.com/o/r/pull/7#issuecomment-${url.split("/").pop()}` });
    if (method === "POST") return json(201, { id: 99, html_url: "https://github.com/o/r/pull/7#issuecomment-99" });
    return json(404, {});
  }) as typeof globalThis.fetch;
  return { calls, fetch: fake };
}

const ctx = (f: typeof fetch): HostContext => ({ root: "/x", host: { adapter: "github" } as HostContext["host"], config: {}, env: { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t" }, fetch: f });

describe("github prComment", () => {
  const body = `${PR_COMMENT_MARKER}\n**Design system:** this change adds 1 problem.\n`;

  it("updates the comment that carries the marker instead of adding one", async () => {
    const gh = fakeGitHub([{ id: 1, body: "Looks good" }, { id: 5, body: `${PR_COMMENT_MARKER}\nold` }]);
    const r = await githubHost.prComment!({ number: 7 }, { body, marker: PR_COMMENT_MARKER }, ctx(gh.fetch));
    expect(r).toEqual({ action: "updated", url: "https://github.com/o/r/pull/7#issuecomment-5" });
    expect(gh.calls.map((c) => `${c.method} ${c.url.replace("https://api.github.com", "")}`)).toEqual(["GET /repos/o/r/issues/7/comments?per_page=100&page=1", "PATCH /repos/o/r/issues/comments/5"]);
    expect(gh.calls[1]!.body).toEqual({ body });
  });

  it("creates one when there is none, and leaves an identical one alone", async () => {
    const fresh = fakeGitHub([{ id: 1, body: "Looks good" }]);
    expect(await githubHost.prComment!({ number: 7 }, { body, marker: PR_COMMENT_MARKER }, ctx(fresh.fetch))).toEqual({ action: "created", url: "https://github.com/o/r/pull/7#issuecomment-99" });
    expect(fresh.calls.at(-1)).toMatchObject({ method: "POST", body: { body } });

    const same = fakeGitHub([{ id: 5, body }]);
    expect((await githubHost.prComment!({ number: 7 }, { body, marker: PR_COMMENT_MARKER }, ctx(same.fetch))).action).toBe("unchanged");
    expect(same.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("doesn't start a comment when told not to, but still corrects an earlier one", async () => {
    const none = fakeGitHub([]);
    expect((await githubHost.prComment!({ number: 7 }, { body, marker: PR_COMMENT_MARKER, create: false }, ctx(none.fetch))).action).toBe("skipped");
    expect(none.calls.map((c) => c.method)).toEqual(["GET"]);

    const earlier = fakeGitHub([{ id: 5, body: `${PR_COMMENT_MARKER}\nold` }]);
    expect((await githubHost.prComment!({ number: 7 }, { body, marker: PR_COMMENT_MARKER, create: false }, ctx(earlier.fetch))).action).toBe("updated");
  });
});

describe("dsa pr-comment", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let io: CliIo;
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });

  // In CI these tests run inside a GitHub Actions job: keep its pull request out of them.
  const saved = { repo: process.env.GITHUB_REPOSITORY, event: process.env.GITHUB_EVENT_PATH };
  beforeEach(() => {
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_EVENT_PATH;
    dir = tempFixture();
    out = [];
    err = [];
    io = { out: (s) => out.push(s), err: (s) => err.push(s), cwd: dir };
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "base");
  });
  afterEach(() => {
    rmrf(dir);
    if (saved.repo !== undefined) process.env.GITHUB_REPOSITORY = saved.repo;
    if (saved.event !== undefined) process.env.GITHUB_EVENT_PATH = saved.event;
  });

  const run = (...args: string[]) => createProgram(io).parseAsync(["node", "dsa", ...args]);

  it("compares the head with a git ref and writes Markdown", async () => {
    const screen = path.join(dir, "src/screens/contacts.tsx");
    fs.writeFileSync(screen, fs.readFileSync(screen, "utf8").replace('<Button variant="outline">Import', '<Button className="x" variant="outline">Import'));
    fs.writeFileSync(path.join(dir, "src/screens/theme.css"), ".x {\n  color: #123456;\n}\n");
    git("add", "-A");
    git("commit", "-qm", "head");

    await run("pr-comment", ".", "--base", "HEAD~1", "--out", "comment.md");
    const md = fs.readFileSync(path.join(dir, "comment.md"), "utf8");
    expect(md.startsWith(`${PR_COMMENT_MARKER}\n**Design system:** this change adds 2 problems.`)).toBe(true);
    expect(md).toContain("`src/screens/theme.css:2` hard-coded colour `#123456`");
    expect(md).toMatch(/`src\/screens\/contacts\.tsx:\d+` `Button` is given its own `className`/);
    // The temporary worktree is gone.
    expect(execFileSync("git", ["-C", dir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
  });

  it("says so in one line when nothing changed", async () => {
    await run("pr-comment", ".", "--base", "HEAD");
    expect(out.join("\n")).toBe(`${PR_COMMENT_MARKER}\n**Design system:** no change to design-system use.`);
  });

  it("compares two saved scans", async () => {
    fs.writeFileSync(path.join(dir, "base.json"), JSON.stringify(base));
    fs.writeFileSync(path.join(dir, "head.json"), JSON.stringify(head));
    await run("--json", "pr-comment", ".", "--base-scan", "base.json", "--head-scan", "head.json");
    const r = JSON.parse(out.join("\n")) as { clean: boolean; delta: { added: unknown[] }; markdown: string };
    expect(r.clean).toBe(false);
    expect(r.delta.added).toHaveLength(4);
    expect(r.markdown).toContain("with the base scan in base.json");
  });
});
