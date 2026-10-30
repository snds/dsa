import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { flowProblems, guardNetwork, runFlow, type Flow } from '../src/flows.js';

// Scripted flows and the network guard, in a real headless browser against a tiny local page.
// Skipped where no browser is installed (`dsa setup` installs one) or DSA_NO_BROWSER is set.

// DSA_NO_BROWSER=1 skips them on purpose.
const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();

const PAGE = `<!doctype html><html><body>
<button id="c" onclick="document.getElementById('d').hidden=false">Comments</button>
<section id="d" aria-label="Comments" hidden>
  <input aria-label="Add a comment" onkeydown="if(event.key==='Enter'){const p=document.createElement('p');p.textContent=this.value;p.id='posted';document.body.append(p);document.getElementById('edit').hidden=false;fetch('/api/comments',{method:'POST',body:this.value}).catch(()=>{});}">
  <button id="edit" aria-label="Edit comment" hidden onclick="document.body.insertAdjacentHTML('beforeend','<textarea id=editbox></textarea>')">✎</button>
</section>
<label>Photo <input type="file" id="f" onchange="document.body.dataset.file=this.files[0].name"></label>
<input type="checkbox" aria-label="Select row"><input type="checkbox" aria-label="Select row">
<button onclick="document.body.dataset.deleted='1'">Delete all</button>
<script>fetch('https://example.com/track',{method:'POST'}).catch(()=>{}); fetch('/api/status').catch(()=>{});</script>
</body></html>`;

test('flows: post, edit, upload, tick; destructive labels refused; the guard blocks writes, /api/, and other hosts', async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', () => ok()));
  const base = new URL(`http://127.0.0.1:${(server.address() as any).port}/`);
  const page = await browser!.newPage();
  try {
    const net = await guardNetwork(page, base.origin);
    const { __test: t } = await import('../src/shots.js');
    const swept: string[] = [];
    const flow: Flow = { name: 'comment edit', route: '/', steps: [
      { click: 'Comments' }, { fill: { label: 'Add a comment', text: 'Test comment' } }, { press: 'Enter' },
      { click: 'Edit comment', within: 'Comments' }, { upload: 'Photo' }, { check: 'Select row', nth: 1 },
    ] };
    assert.deepEqual(flowProblems(flow), []);
    const r = await runFlow(page, flow, { base, waitMs: 50, inPage: (src, arg) => t.inPage(page, src, arg), sweep: async by => { swept.push(by); }, log: () => {} });
    assert.equal(r.done, true, JSON.stringify(r));
    assert.equal(await page.textContent('#posted'), 'Test comment');
    assert.ok(await page.$('#editbox'), 'the edit box opened');
    assert.equal(await page.evaluate('document.body.dataset.file'), 'dsa-test.png');
    assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('input[type=checkbox]')).map(c => c.checked)`), [false, true]);
    assert.match(swept.at(-1)!, /flow “comment edit”: clicking “Comments” › typing into “Add a comment” › pressing Enter/);
    // Writes, /api/, and other hosts never leave the page.
    await page.waitForTimeout(200);
    assert.ok(net.blocked >= 3, JSON.stringify(net));
    assert.ok(net.last.some(x => x.startsWith('POST') && x.includes('/api/comments')), JSON.stringify(net.last));
    // Compare the parsed host, not a substring of the URL text.
    assert.ok(net.last.some(x => { try { return new URL(x.split(' ')[1]).hostname === 'example.com'; } catch { return false; } }), JSON.stringify(net.last));
    // A destructive label is refused, as written and at run time.
    const bad: Flow = { name: 'bad', route: '/', steps: [{ click: 'Delete all' }] };
    assert.match(flowProblems(bad).join(' '), /never acted on/);
    const rb = await runFlow(page, bad, { base, waitMs: 50, inPage: (src, arg) => t.inPage(page, src, arg), sweep: async () => {}, log: () => {} });
    assert.equal(rb.done, false);
    assert.equal(await page.evaluate('document.body.dataset.deleted'), undefined);
  } finally { await page.close(); server.close(); }
});

test('flows: problems are reported per step', () => {
  assert.deepEqual(flowProblems({ name: 'x', route: '#/', steps: [{ click: 'Save' }] }), []);
  assert.match(flowProblems({ name: 'x', route: '#/', steps: [{ click: 'A', hover: 'B' }] }).join(), /exactly one/);
  assert.match(flowProblems({ name: 'x', route: '#/', steps: [{ press: 'Meta+A' }] }).join(), /press takes/);
  assert.match(flowProblems({ name: 'x', route: '#/', steps: [{ wait: 60000 }] }).join(), /wait is/);
  assert.match(flowProblems({ route: '#/', steps: [] }).join(), /no name.*no steps/);
});

afterAll(async () => { await browser?.close(); });
