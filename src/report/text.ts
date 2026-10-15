import type { PatternsReport } from "../patterns.js";
import type { RatchetReport } from "../ratchet.js";
import type { ScanReport } from "../scan.js";
import { renderAnatomy } from "../detect/anatomy.js";
import type { Counts } from "../metrics/adoption.js";

type Align = "left" | "right";

/** Plain padded table; no table library, no ANSI inside cells. */
export function table(headers: string[], rows: string[][], align: Align[] = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => {
        const w = widths[i] ?? c.length;
        return (align[i] ?? "left") === "right" ? c.padStart(w) : c.padEnd(w);
      })
      .join("  ")
      .trimEnd();
  const line = widths.map((w) => "-".repeat(w)).join("  ");
  return [fmt(headers), line, ...rows.map(fmt)].join("\n");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function countsRow(label: string, c: Counts): string[] {
  return [label, String(c.ds), String(c.local), String(c.html), String(c.external), String(c.total), pct(c.customRatio)];
}

export function formatScan(report: ScanReport): string {
  const out: string[] = [];
  const t = report.adoption.total;
  out.push(`dsa scan — ${report.system} — ${report.files.length} files, ${t.total} elements (${report.dsSourceFiles.length} DS source files parsed, not counted)`);
  out.push("");
  const dirRows = Object.entries(report.adoption.byDir)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, c]) => countsRow(dir, c));
  out.push(table(["directory", "ds", "local", "html", "external", "total", "custom"], [...dirRows, countsRow("TOTAL", t)], ["left", "right", "right", "right", "right", "right", "right"]));
  out.push("");
  const dsRows = Object.entries(report.inventory.ds)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 15)
    .map(([name, u]) => [name, String(u.count), String(u.files.length)]);
  out.push(table(["ds component", "uses", "files"], dsRows, ["left", "right", "right"]));
  out.push("");
  const cu = report.correctUse.counts;
  out.push("correct use");
  out.push(
    table(
      ["check", "count"],
      [
        ["className overrides on DS", String(cu.classNameOverrides)],
        ["style overrides on DS", String(cu.styleOverrides)],
        ["spread props on DS", String(cu.spreadProps)],
        ["local look-alikes", String(cu.lookAlikes)],
      ],
      ["left", "right"],
    ),
  );
  if (report.correctUse.lookAlikes.length > 0) {
    out.push("");
    out.push(
      table(
        ["look-alike", "resembles", "score", "uses"],
        report.correctUse.lookAlikes.map((l) => [l.name, l.dsComponent, l.score.toFixed(2), String(l.usages)]),
        ["left", "left", "right", "right"],
      ),
    );
  }
  return out.join("\n");
}

export function formatPatterns(report: PatternsReport): string {
  const out: string[] = [];
  const th = report.thresholds;
  out.push(
    `dsa patterns — ${report.system} — ${report.summary.compositionsSeen} compositions seen, ${report.summary.candidates} candidates (rule: ${th.minOccurrences}+ occurrences across ${th.minHosts}+ ${th.hostsBy === "dir" ? "directories" : "files"})`,
  );
  out.push("");
  if (report.candidates.length === 0) {
    out.push("No candidates at the current thresholds. Run with --all to see host-local compositions.");
  } else {
    out.push(
      table(
        ["tier", "name", "occ", "hosts", "conf", "nearest", "anatomy"],
        report.candidates.map((c) => [
          c.tier,
          c.name,
          String(c.occurrences.length),
          String(c.hosts.length),
          c.confidence.toFixed(2),
          c.nearestExisting ? `${c.nearestExisting.name} (${c.nearestExisting.score.toFixed(2)})` : "-",
          truncate(renderAnatomy(c.anatomy), 60),
        ]),
        ["left", "left", "right", "right", "right", "left", "left"],
      ),
    );
    out.push("");
    for (const c of report.candidates) {
      out.push(`${c.name} [${c.id}] — ${c.reason}`);
      for (const o of c.occurrences.slice(0, 5)) out.push(`    ${o.file}:${o.line}:${o.column}`);
      if (c.occurrences.length > 5) out.push(`    … ${c.occurrences.length - 5} more`);
    }
  }
  if (report.parked.length > 0) {
    out.push("");
    out.push(`parked (ignored ${report.parked[0]?.ignoredTimes ?? ""}+ times): ${report.parked.map((p) => `${p.name} [${p.id}]`).join(", ")}`);
  }
  out.push("");
  out.push("People decide; the tool suggests. Nothing here was created.");
  return out.join("\n");
}

export function formatRatchet(report: RatchetReport): string {
  const out: string[] = [];
  const verb = report.action === "compared" ? (report.ok ? "OK" : "FAILED") : report.action.toUpperCase();
  out.push(`dsa ratchet — ${verb} — baseline ${report.baselinePath}`);
  out.push("");
  const keys = ["classNameOverrides", "styleOverrides", "spreadProps", "lookAlikes"] as const;
  out.push(
    table(
      ["metric", "baseline", "current", "delta"],
      keys.map((k) => [k, report.baseline ? String(report.baseline[k]) : "-", String(report.current[k]), report.baseline ? signed(report.deltas[k]) : "-"]),
      ["left", "right", "right", "right"],
    ),
  );
  if (!report.ok) {
    out.push("");
    out.push(`Grew: ${report.grew.join(", ")}. Fix the new findings or run "dsa ratchet --update" if the growth was accepted in review.`);
  }
  return out.join("\n");
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
