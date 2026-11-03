import path from 'node:path';
import { TAG_ATTR, tagEnabled, tagFileOf, type TagOptions } from './index.js';

/**
 * The Babel plugin, and through it Next.js with a Babel config (Next uses SWC otherwise, which this
 * doesn't cover). Same tags as the Vite plugin, off unless DSA_TAG=1 or `{ when: true }`:
 *
 *   // babel.config.js
 *   module.exports = { presets: ['next/babel'], plugins: ['@snds/dsa/tag/babel'] };
 */
export default function dsaTagBabel(api: any, opts: TagOptions = {}) {
  const t = api.types;
  const on = tagEnabled(opts);
  const comps = opts.components;
  return {
    name: 'dsa-tag',
    visitor: {
      JSXOpeningElement(p: any, state: any) {
        if (!on) return;
        const n = p.node;
        const file: string | undefined = state.filename;
        if (!file || !n.loc) return;
        const rel = tagFileOf(path.resolve(file), opts);
        if (!rel) return;
        const name = n.name.type === 'JSXIdentifier' ? n.name.name : n.name.type === 'JSXMemberExpression' ? memberName(n.name) : null;
        if (!name) return;
        const host = n.name.type === 'JSXIdentifier' && /^[a-z]/.test(name) && !name.includes('-');
        if (!host && !(comps === true ? !/(^|\.)Fragment$/.test(name) : Array.isArray(comps) && comps.includes(name))) return;
        if (n.attributes.some((a: any) => a.type === 'JSXAttribute' && a.name?.name === TAG_ATTR)) return;
        // Babel's columns count from 0; the scanner's from 1.
        n.attributes.unshift(t.jsxAttribute(t.jsxIdentifier(TAG_ATTR), t.stringLiteral(`${rel}:${n.loc.start.line}:${n.loc.start.column + 1}`)));
      },
    },
  };
}

const memberName = (n: any): string | null => n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? `${memberName(n.object)}.${n.property.name}` : null;
