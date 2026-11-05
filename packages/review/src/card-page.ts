import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureBrowser } from './apps.js';

/**
 * Open a published dashboard (dsa publish) in a headless browser, show every Element Review card (the
 * "All" filter, every "Show more"), and run `probe` on the page: a function in a string,
 * `(document, arg) => result`, such as the dashboard's PROBE_CARDS. Nothing is written; the page is
 * read from disk as it is.
 */
export async function onReviewPage<T>(siteDir: string, probe: string, arg: unknown = {}, log: (m: string) => void = () => {}): Promise<T> {
  const pw = await ensureBrowser(log);
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto(`${pathToFileURL(path.join(path.resolve(siteDir), 'index.html')).href}#elements`);
    await page.waitForSelector('[data-slot="card"], [role="group"][aria-label="Show"]', { timeout: 30_000 });
    // Every card, whatever its status.
    const all = page.locator('[aria-label="Show"] button', { hasText: /^All/ });
    if (await all.count()) await all.first().click();
    // Every card in every group: press "Show N more" until none is left (each press adds a few).
    for (let i = 0; i < 2000; i++) {
      const more = page.locator('button', { hasText: /^Show \d+ more of \d+$/ });
      if (!(await more.count())) break;
      await more.first().click();
    }
    return await page.evaluate(([src, a]: [string, unknown]) => (0, eval)(`(${src})`)((globalThis as any).document, a), [probe, arg]);
  } finally {
    await browser.close();
  }
}
