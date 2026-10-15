import fs from "node:fs";
import path from "node:path";

export type DecisionStatus = "ignored" | "parked" | "accepted";

export interface Decision {
  status: DecisionStatus;
  ignoredTimes: number;
  name?: string;
  updatedAt: string;
}

export interface DecisionsFile {
  version: 1;
  decisions: Record<string, Decision>;
}

export function loadDecisions(file: string): DecisionsFile {
  if (!fs.existsSync(file)) return { version: 1, decisions: {} };
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DecisionsFile>;
  return { version: 1, decisions: raw.decisions ?? {} };
}

export function saveDecisions(file: string, data: DecisionsFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Record one more "ignore" for a candidate. Once it has been ignored `limit`
 * times it is parked and the detector stops raising it (rule 7 of the decision).
 */
export function ignoreCandidate(data: DecisionsFile, id: string, limit: number, name?: string): Decision {
  const prev = data.decisions[id];
  const ignoredTimes = (prev?.ignoredTimes ?? 0) + 1;
  const decision: Decision = {
    status: ignoredTimes >= limit ? "parked" : "ignored",
    ignoredTimes,
    updatedAt: new Date().toISOString(),
  };
  const label = name ?? prev?.name;
  if (label) decision.name = label;
  data.decisions[id] = decision;
  return decision;
}
