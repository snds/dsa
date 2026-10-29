import { parseFigmaUrl, type Config, type FigmaUsageRow } from '@snds/dsa/engine';

/**
 * Figma crawler for Organization plans (the Library Analytics and Variables APIs are Enterprise-only).
 * Uses only the standard file endpoints, which every plan has:
 *   GET /v1/teams/:id/projects, /v1/projects/:id/files, /v1/files/:key, /v1/files/:key/components, /component_sets
 * Counts top-level instances whose main component comes from a configured library, plus frames
 * named like a library component that are NOT instances (a sampled detach / look-alike proxy).
 */
export type Fetcher = (url: string) => Promise<any>;

export function figmaFetcher(token: string, base = 'https://api.figma.com'): Fetcher {
  return async (url: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(base + url, { headers: { 'X-Figma-Token': token } });
      if (r.status === 429) {
        const wait = Number(r.headers.get('retry-after') ?? 10) * 1000;
        await new Promise(res => setTimeout(res, Math.min(wait, 60000)));
        continue;
      }
      if (!r.ok) throw new Error(`Figma ${r.status} on ${url}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    }
    throw new Error(`Figma rate limit persisted on ${url}`);
  };
}

interface LibComponent { library: string; component: string }

export { parseFigmaUrl };

/** Check a token: GET /v1/me. */
export async function figmaWhoAmI(token: string): Promise<{ handle: string; email?: string }> {
  const r = await fetch('https://api.figma.com/v1/me', { headers: { 'X-Figma-Token': token } });
  if (!r.ok) throw new Error(r.status === 403 ? 'Figma rejected the token (403). Check it has file read scope.' : `Figma ${r.status}`);
  const j: any = await r.json();
  return { handle: j.handle, email: j.email };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** What happened during a crawl, so the report can explain an empty or partial result. */
export interface FigmaCrawlDiag {
  libraries: { name: string; fileKey: string; components: number; sets: number; error?: string }[];
  sources: { teams: number; projects: number; files: number };
  files: { key: string; name: string; project: string; status: 'crawled' | 'stale' | 'library' | 'capped' | 'error'; instances?: number; lookalikes?: number; otherInstances?: number; error?: string }[];
  errors: string[];
}

const short = (e: any) => String(e?.message ?? e).slice(0, 200);

export async function crawlFigma(config: Config, fetcher: Fetcher, now = new Date()): Promise<{ rows: FigmaUsageRow[]; filesCrawled: number; skipped: string[]; diag: FigmaCrawlDiag }> {
  const fc = config.figma ?? {};
  const diag: FigmaCrawlDiag = { libraries: [], sources: { teams: 0, projects: 0, files: 0 }, files: [], errors: [] };
  const byKey = new Map<string, LibComponent>();
  const names = new Map<string, LibComponent>();
  for (const lib of fc.libraries ?? []) {
    const d: FigmaCrawlDiag['libraries'][number] = { name: lib.name, fileKey: lib.fileKey, components: 0, sets: 0 };
    diag.libraries.push(d);
    try {
      const comps = (await fetcher(`/v1/files/${lib.fileKey}/components`))?.meta?.components ?? [];
      const sets = (await fetcher(`/v1/files/${lib.fileKey}/component_sets`))?.meta?.component_sets ?? [];
      d.components = comps.length; d.sets = sets.length;
      if (!comps.length) d.error = 'No published components. Publish the library (Assets › Team library) so its components get keys.';
      for (const c of comps) {
        const component = c.containing_frame?.containingComponentSet?.name ?? c.name;
        byKey.set(c.key, { library: lib.name, component });
        names.set(norm(component), { library: lib.name, component });
      }
      for (const s of sets) names.set(norm(s.name), { library: lib.name, component: s.name });
    } catch (e) { d.error = short(e); }
  }
  // Every library failed (bad token, no access): stop here so the caller reports it as a failed crawl.
  if (diag.libraries.length && diag.libraries.every(l => l.error && !l.components)) {
    const firstErr = diag.libraries.find(l => l.error && !/No published/.test(l.error))?.error;
    if (firstErr) throw new Error(`Could not read any library file: ${firstErr}`);
  }

  // Which files to crawl. Pasted links resolve into the same three lists.
  const files: { key: string; name: string; project: string; lastModified?: string }[] = [];
  const linked = (fc.links ?? []).map(l => parseFigmaUrl(l.url)).filter(Boolean) as { kind: string; id: string }[];
  for (const key of [...(fc.fileKeys ?? []), ...linked.filter(l => l.kind === 'file').map(l => l.id)]) files.push({ key, name: key, project: '(listed)' });
  const projectIds = [...(fc.projectIds ?? []), ...linked.filter(l => l.kind === 'project').map(l => l.id)];
  const teamIds = [...(fc.teamIds ?? []), ...linked.filter(l => l.kind === 'team').map(l => l.id)];
  const projectNames = new Map<string, string>();
  for (const team of teamIds) {
    try {
      for (const p of (await fetcher(`/v1/teams/${team}/projects`))?.projects ?? []) { projectIds.push(String(p.id)); projectNames.set(String(p.id), p.name); }
    } catch (e) { diag.errors.push(`Team ${team}: ${short(e)}`); }
  }
  for (const pid of projectIds) {
    try {
      for (const f of (await fetcher(`/v1/projects/${pid}/files`))?.files ?? []) {
        files.push({ key: f.key, name: f.name, project: projectNames.get(pid) ?? pid, lastModified: f.last_modified });
      }
    } catch (e) { diag.errors.push(`Project ${pid}: ${short(e)}`); }
  }
  diag.sources = { teams: teamIds.length, projects: projectIds.length, files: files.length };

  const libKeys = new Set((fc.libraries ?? []).map(l => l.fileKey));
  const days = fc.editedWithinDays ?? 90;
  const cutoff = now.getTime() - days * 864e5;
  const max = fc.maxFiles ?? 200;
  const skipped: string[] = [];
  const todo: typeof files = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    const base = { key: f.key, name: f.name, project: f.project };
    if (libKeys.has(f.key)) { diag.files.push({ ...base, status: 'library' }); continue; }
    if (f.lastModified && Date.parse(f.lastModified) < cutoff) { skipped.push(f.key); diag.files.push({ ...base, status: 'stale' }); continue; }
    if (todo.length >= max) { diag.files.push({ ...base, status: 'capped' }); continue; }
    todo.push(f);
  }

  const rows: FigmaUsageRow[] = [];
  let crawled = 0;
  for (const f of todo) {
    const fd: FigmaCrawlDiag['files'][number] = { key: f.key, name: f.name, project: f.project, status: 'crawled', instances: 0, lookalikes: 0, otherInstances: 0 };
    diag.files.push(fd);
    let doc: any;
    // One unreadable file (no access, deleted) shouldn't end the crawl.
    try { doc = await fetcher(`/v1/files/${f.key}`); } catch (e) { fd.status = 'error'; fd.error = short(e); continue; }
    crawled++;
    fd.name = doc.name ?? f.name;
    const compMeta: Record<string, { key: string }> = doc.components ?? {};
    const counts = new Map<string, FigmaUsageRow>();
    const bump = (lc: LibComponent, field: 'instances' | 'lookalikeFrames') => {
      const k = lc.library + '|' + lc.component;
      if (!counts.has(k)) counts.set(k, { fileKey: f.key, fileName: fd.name, project: f.project, library: lc.library, component: lc.component, instances: 0, lookalikeFrames: 0 });
      counts.get(k)![field]++;
      if (field === 'instances') fd.instances!++; else fd.lookalikes!++;
    };
    const walkNode = (n: any) => {
      if (n.type === 'INSTANCE') {
        const key = compMeta[n.componentId]?.key;
        const lc = key ? byKey.get(key) : undefined;
        if (lc) bump(lc, 'instances'); else fd.otherInstances!++; // local or another library's component
        return; // nested instances belong to the component, not the designer
      }
      if ((n.type === 'FRAME' || n.type === 'GROUP') && n.name) {
        const lc = names.get(norm(n.name));
        if (lc) bump(lc, 'lookalikeFrames');
      }
      for (const c of n.children ?? []) walkNode(c);
    };
    walkNode(doc.document ?? {});
    rows.push(...counts.values());
  }
  return { rows, filesCrawled: crawled, skipped, diag };
}
