// The review demo's built pages, built again from their source with source tags on: each app's Toolbar,
// its form of selects (Invoices, Cart) and its Footer are tagged (@snds/dsa/tag), compiled, and rendered
// with React in place of the hand-written markup, with the props the hand-written pages show. System
// components render nothing here (the demo has no built system to draw them); the rest of each page is
// left as it is (untagged), the way a real build mixes tagged app code with markup from elsewhere.
//
// Used by `node scripts/review-demo.mjs <out> --tag` and the source-tag browser test. Dependencies come
// in as arguments, so the test can pass the source and the script the built package.
import fs from 'node:fs';
import path from 'node:path';

const ROWS = [
  { id: 'INV-1042', name: 'Lumen Labs', status: 'Paid', amount: '$1,200', due: 'Nov 4' },
  { id: 'INV-1043', name: 'Okapi Foods', status: 'Due', amount: '$310', due: 'Nov 9' },
  { id: 'INV-1044', name: 'Harbor & Co', status: 'Paid', amount: '$2,450', due: 'Nov 12' },
];
const PROPS = { billing: { rows: ROWS, paidOnly: true }, checkout: {} };

/** Rewrite apps/<app>/site/index.html under `root` with tagged renders. Returns the tags written, per app. */
export async function tagDemoSites(root, { tagSource, ts, React, renderToStaticMarkup }) {
  const out = {};
  for (const app of ['billing', 'checkout']) {
    const page = path.join(root, 'apps', app, 'site', 'index.html');
    let html = fs.readFileSync(page, 'utf8');
    out[app] = [];
    const parts = [['Toolbar', /<section class="toolbar">[\s\S]*?<\/section>/], [app === 'billing' ? 'Invoices' : 'Cart', /<p>[^]*?<select>[^]*?<\/p>/], ['Footer', /<footer class="foot">[\s\S]*?<\/footer>/]];
    for (const [name, find] of parts) {
      const file = path.join(root, 'apps', app, 'src', `${name}.tsx`);
      const tagged = tagSource(fs.readFileSync(file, 'utf8'), file, { when: true, root });
      if (!tagged) throw new Error(`nothing tagged in ${file}`);
      out[app].push(...tagged.tags);
      // Imports from packages (the system's components) become components that draw nothing.
      const code = tagged.code.replace(/^import \{([^}]*)\} from '[^.][^']*';$/gm, (_, names) => names.split(',').map(n => `const ${n.trim()} = () => null;`).join(' '));
      const js = ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: 'h', module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      globalThis.__dsaDemoH = React.createElement;
      const mod = await import('data:text/javascript,' + encodeURIComponent(`const h = globalThis.__dsaDemoH;\n${js}`));
      const markup = renderToStaticMarkup(React.createElement(mod[name], PROPS[app]));
      html = html.replace(find, () => markup);
    }
    fs.writeFileSync(page, html);
  }
  return out;
}
