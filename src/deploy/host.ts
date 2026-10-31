import fs from "node:fs";
import path from "node:path";
import type { HostAdapter, HostContext, PageActions } from "./types.js";

/**
 * The generic host adapter: any static host, any CI. Re-scan is a link to (or a POST at) whatever
 * starts the scan job; decisions are a downloaded file, or POSTed to a webhook. `dsa apply-decisions`
 * reads a file, stdin ("-") or a URL.
 */
export const genericHost: HostAdapter = {
  id: "generic",
  actions({ host }): PageActions {
    const r = host.rescan;
    const d = host.decisions;
    const apply = "dsa apply-decisions --file <dsa-decisions.json>";
    return {
      host: "generic",
      rescan: r
        ? r.method === "post"
          ? { kind: "post", url: r.url, label: r.label ?? "Request a re-scan", help: `Asks the scan job at ${hostOf(r.url)} to run. This page doesn't change by itself: the new scan shows after the job publishes it.` }
          : { kind: "link", url: r.url, label: r.label ?? `Re-scan on ${hostOf(r.url)}`, help: `Opens ${hostOf(r.url)} in a new tab, where you start the scan job. This page updates after the job publishes the new scan.` }
        : { kind: "none", label: "Re-scan", help: "This dashboard is rebuilt by the scan job on each deploy. Set host.rescan to add a button that starts it." },
      decisions:
        d?.mode === "post" && d.url
          ? { kind: "post", url: d.url, label: "Send decisions", help: "Sends the staged decisions to the team's webhook, which applies them.", apply }
          : { kind: "export", label: "Download decisions", help: "Download the file, then apply it from the repo root.", apply },
    };
  },
  async readDecisions(ref, c) {
    if (/^https?:\/\//.test(ref)) {
      const r = await c.fetch(ref, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`${ref} answered ${r.status}.`);
      return r.json();
    }
    const text = ref === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(ref), "utf8");
    return JSON.parse(text);
  },
};

/** "ci.example.com" from a URL, for button text; the URL itself if it doesn't parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Pick the adapter the config names (host.adapter, default "generic") from the built-ins and any an
 * add-on offers. An unknown name is an error, never a silent fallback: the buttons would go nowhere.
 */
export function hostAdapter(id: string | undefined, available: HostAdapter[]): HostAdapter {
  const want = id ?? "generic";
  const a = [...available].reverse().find((x) => x.id === want);
  if (!a) throw new Error(`host.adapter is "${want}", and no installed adapter has that name (known: ${[...new Set(available.map((x) => x.id))].join(", ")}).`);
  return a;
}

/** The fenced decisions file inside a longer text (an issue body or comment), or null. */
export function decisionsIn(text: string): unknown | null {
  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)) {
    try {
      const j = JSON.parse(m[1]!) as { dsa?: string };
      if (j && j.dsa === "decisions") return j;
    } catch {
      /* not this block */
    }
  }
  try {
    const j = JSON.parse(text) as { dsa?: string };
    if (j && j.dsa === "decisions") return j;
  } catch {
    /* plain text */
  }
  return null;
}

export type { HostAdapter, HostContext, PageActions };
