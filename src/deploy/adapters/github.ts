import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { NO_RELAY, decisionsIn, genericHost, relayRescan } from "../host.js";
import type { HostAdapter, HostContext, PageActions, RevisionSource } from "../types.js";

/**
 * The GitHub host adapter. Re-scan goes through the scan relay (host.relay), which starts the scan
 * workflow with workflow_dispatch using its own credential; decisions become an issue with a label a workflow listens for, which runs
 * `dsa apply-decisions --issue <n>` and commits the result or opens a pull request. The live
 * revision can come from the repo's deployments (GitHub Pages records one per deploy).
 *
 * Everything here is reached through the HostAdapter interface; the core never names GitHub.
 */

function settings(c: Pick<HostContext, "host" | "config" | "env">) {
  const g = c.host.github;
  const server = (g?.server ?? "https://github.com").replace(/\/+$/, "");
  const api = (g?.api ?? (server === "https://github.com" ? "https://api.github.com" : `${server}/api/v3`)).replace(/\/+$/, "");
  const repo = g?.repo ?? c.config.github?.defaultRepo ?? c.env.GITHUB_REPOSITORY;
  return { server, api, repo, workflow: g?.workflow ?? "dsa.yml", ref: g?.ref, label: g?.label ?? "dsa-decisions", rescanLabel: g?.rescanLabel ?? "dsa-rescan" };
}

async function gh(c: HostContext, method: string, pathname: string, body?: unknown): Promise<any> {
  const t = c.env.GITHUB_TOKEN || c.env.GH_TOKEN;
  const r = await c.fetch(`${settings(c).api}${pathname}`, {
    method,
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${pathname.split("?")[0]} answered ${r.status}${!t ? " (no GITHUB_TOKEN set)" : r.status === 403 || r.status === 404 ? " (check the token's permissions)" : ""}.`);
  return r.status === 204 ? null : r.json();
}

const isIssueRef = (ref: string) => /^#?\d+$|\/issues\/\d+\/?$/.test(ref.trim());

/** The cron lines in a workflow file of the measured repo, or none. */
export function workflowCrons(root: string, workflow: string): string[] {
  for (const dir of [".github/workflows"]) {
    const f = path.join(root, dir, workflow);
    if (!fs.existsSync(f)) continue;
    try {
      const doc = parseYaml(fs.readFileSync(f, "utf8")) as { on?: { schedule?: { cron?: unknown }[] } } | null;
      return (doc?.on?.schedule ?? []).map((s) => s?.cron).filter((c): c is string => typeof c === "string");
    } catch {
      return [];
    }
  }
  return [];
}

/** The workflow declares a `shots` input, so a re-scan can say what to do with earlier photos. */
export function workflowTakesShots(root: string, workflow: string): boolean {
  try {
    const doc = parseYaml(fs.readFileSync(path.join(root, ".github/workflows", workflow), "utf8")) as { on?: { workflow_dispatch?: { inputs?: { shots?: unknown } } | null } } | null;
    return Boolean(doc?.on?.workflow_dispatch?.inputs?.shots);
  } catch {
    return false;
  }
}

/** The terminal command that starts the scan workflow, for a page that can't start it itself. */
function runCommand(s: { server: string; repo?: string | undefined; workflow: string; ref?: string | undefined }): string {
  const host = new URL(s.server).host;
  return `gh workflow run ${s.workflow} --repo ${host === "github.com" ? "" : `${host}/`}${s.repo}${s.ref ? ` --ref ${s.ref}` : ""}`;
}

/** "12", "#12" or an issue URL → 12. */
export function issueNumber(ref: string): number {
  const m = ref.trim().match(/(?:^#?|\/issues\/)(\d+)\/?$/);
  if (!m) throw new Error(`"${ref}" isn't an issue number or issue link.`);
  return Number(m[1]);
}

/** The latest deployment to an environment (default github-pages) that finished successfully. */
function deploymentSource(c: HostContext): RevisionSource {
  return {
    id: "github-deployment",
    async resolve(rc) {
      const ctx: HostContext = { ...c, env: rc.env, fetch: rc.fetch };
      const s = settings(ctx);
      if (!s.repo) return null;
      const env = rc.live.revision.environment ?? "github-pages";
      const deps: any[] = await gh(ctx, "GET", `/repos/${s.repo}/deployments?environment=${encodeURIComponent(env)}&per_page=10`);
      for (const d of deps ?? []) {
        const statuses: any[] = await gh(ctx, "GET", `/repos/${s.repo}/deployments/${d.id}/statuses?per_page=5`);
        const done = (statuses ?? []).find((x) => x.state === "success");
        // A newer deployment that is still running or failed isn't live: an older one is.
        if (done) return { sha: String(d.sha), liveAt: String(done.created_at ?? d.created_at), via: `${env} deployment ${d.id} on ${s.repo}` };
      }
      return null;
    },
  };
}

export const githubHost: HostAdapter = {
  id: "github",
  actions(c): PageActions {
    const s = settings(c);
    const generic = genericHost.actions(c);
    if (!s.repo) {
      return { ...generic, host: "github", rescan: { ...generic.rescan, help: `${generic.rescan.help} The github adapter links the workflow once host.github.repo (or github.defaultRepo) is set.` } };
    }
    const mode = c.host.decisions?.mode ?? "issue";
    const shots = workflowTakesShots(c.root, s.workflow) ? { shots: true } : {};
    return {
      host: "github",
      rescan: c.host.relay?.url
        ? { ...relayRescan(c.host.relay.url, c.host.relay.label, c.host.rescan?.estimateSeconds), ...shots, help: `Starts the ${s.workflow} workflow in ${s.repo} through the scan relay at ${new URL(c.host.relay.url).host} and shows its progress here. You sign in with GitHub first; the new report loads once that run has deployed.` }
        : c.host.rescan?.method === "issue"
        ? {
            kind: "issue",
            url: `${s.server}/${s.repo}/issues/new`,
            label: c.host.rescan.label ?? "Re-scan",
            title: "Re-scan the dsa dashboard",
            labels: [s.rescanLabel],
            ...shots,
            help: `Opens a filled-in issue on ${s.repo}. Submit it and the scan starts; the issue shows its progress and closes when this page is updated.`,
            estimateSeconds: c.host.rescan.estimateSeconds ?? null,
          }
        : c.host.rescan
        ? { ...generic.rescan, ...(generic.rescan.kind === "link" ? { ...shots, command: runCommand(s) } : {}) }
        : { kind: "none", label: "Re-scan", help: NO_RELAY },
      decisions:
        mode === "issue" || mode === "pr"
          ? {
              kind: "issue",
              url: `${s.server}/${s.repo}/issues/new`,
              title: "Review decisions from the dashboard",
              labels: [s.label],
              label: "File decisions on GitHub",
              help: mode === "pr" ? "Opens an issue with the decisions. A workflow applies them and opens a pull request for review." : "Opens an issue with the decisions. A workflow applies them to the repo and closes the issue.",
              apply: "dsa apply-decisions --issue <number>",
            }
          : generic.decisions,
    };
  },
  async readDecisions(ref, c) {
    if (!isIssueRef(ref)) return genericHost.readDecisions(ref, c);
    const s = settings(c);
    if (!s.repo) throw new Error("The github adapter needs host.github.repo (or github.defaultRepo, or GITHUB_REPOSITORY) to read an issue.");
    const n = issueNumber(ref);
    const issue = await gh(c, "GET", `/repos/${s.repo}/issues/${n}`);
    // The newest comment wins: someone may have corrected the decisions after filing.
    const comments: any[] = issue.comments ? await gh(c, "GET", `/repos/${s.repo}/issues/${n}/comments?per_page=100`) : [];
    for (const text of [...comments.map((x) => String(x.body ?? "")).reverse(), String(issue.body ?? "")]) {
      const d = decisionsIn(text);
      if (d) return d;
    }
    throw new Error(`Issue #${n} on ${s.repo} has no decisions file (a \`\`\`json block with "dsa": "decisions").`);
  },
  async applied(ref, summary, c) {
    if (!isIssueRef(ref)) return;
    const s = settings(c);
    const n = issueNumber(ref);
    await gh(c, "POST", `/repos/${s.repo}/issues/${n}/comments`, { body: summary });
    await gh(c, "PATCH", `/repos/${s.repo}/issues/${n}`, { state: "closed", state_reason: "completed" });
  },
  async prComment(pr, comment, c) {
    const repo = pr.repo ?? settings(c).repo;
    if (!repo) throw new Error("The github adapter needs a repo to comment on a pull request: pass --repo, or set GITHUB_REPOSITORY or host.github.repo.");
    if (!comment.body.includes(comment.marker)) throw new Error("The comment body must carry its marker.");
    // A pull request's conversation is its issue comments. Look through every page for ours.
    let existing: any = null;
    for (let page = 1; page <= 30 && !existing; page++) {
      const list: any[] = (await gh(c, "GET", `/repos/${repo}/issues/${pr.number}/comments?per_page=100&page=${page}`)) ?? [];
      existing = list.find((x) => String(x.body ?? "").includes(comment.marker)) ?? null;
      if (list.length < 100) break;
    }
    if (existing) {
      if (String(existing.body ?? "") === comment.body) return { action: "unchanged", url: existing.html_url };
      const done = await gh(c, "PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body: comment.body });
      return { action: "updated", url: done?.html_url ?? existing.html_url };
    }
    if (comment.create === false) return { action: "skipped" };
    const made = await gh(c, "POST", `/repos/${repo}/issues/${pr.number}/comments`, { body: comment.body });
    return { action: "created", url: made?.html_url };
  },
  fileUrl(f, c) {
    const s = settings(c);
    const repo = f.repo ?? s.repo;
    if (!repo) return undefined;
    const file = f.path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
    return `${s.server}/${repo}/blob/${f.sha}/${file}${f.line ? `#L${f.line}` : ""}`;
  },
  revisionSources: (c) => [deploymentSource(c)],
  // The workflow's own schedule (on.schedule[].cron, always UTC on GitHub), unless the config says otherwise.
  schedule: (c) => c.host.schedule ?? workflowCrons(c.root, settings(c).workflow),
};
