import { decisionsIn, genericHost } from "../host.js";
import type { HostAdapter, HostContext, PageActions, RevisionSource } from "../types.js";

/**
 * The GitHub host adapter. Re-scan opens the scan workflow's page (its Run workflow button is
 * workflow_dispatch); decisions become an issue with a label a workflow listens for, which runs
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
  return { server, api, repo, workflow: g?.workflow ?? "dsa.yml", ref: g?.ref, label: g?.label ?? "dsa-decisions" };
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
    return {
      host: "github",
      rescan: c.host.rescan
        ? generic.rescan
        : {
            kind: "link",
            url: `${s.server}/${s.repo}/actions/workflows/${encodeURIComponent(s.workflow)}`,
            label: "Re-scan",
            help: `Opens the ${s.workflow} workflow on GitHub. Press Run workflow${s.ref ? ` on ${s.ref}` : ""}; the dashboard updates when it finishes.`,
          },
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
  revisionSources: (c) => [deploymentSource(c)],
};
