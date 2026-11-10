#!/usr/bin/env node
/**
 * Vendors the icon pack agent keys can wear (docs/internal/agent-keys.md,
 * "The icon pack") as data: Lucide's drawings, names, tags and categories,
 * written into packages/companion-protocol/src/agent-key-pack/ for the desk,
 * the phone and the Mac to read. Not a runtime dependency: run it by hand to
 * move to a newer Lucide, then commit what it writes.
 *
 *   node scripts/agent-key-pack.mjs <lucide repo checkout> <lucide-static package dir>
 *
 * The repo checkout (github.com/lucide-icons/lucide at a release tag) has
 * each icon's tags and categories (`icons/*.json`) and the category titles
 * (`categories/*.json`); the `lucide-static` package of the same version has
 * the drawings (`icon-nodes.json`) and the licence.
 *
 * Every drawing becomes what our own legends are: SVG path data and plain
 * circles on the 24 grid, strokes only. Rects, ellipses, lines and polylines
 * are turned into paths, and the few filled dots lose their fill (stroked,
 * they still read as dots), so a client draws a pack icon exactly as it
 * draws a featured one.
 *
 * Writes:
 *   index.json        version, categories, and every icon's name, tags and categories (the search)
 *   drawings-<c>.json the drawings, one file per first character, loaded only when needed
 *   LICENSE           Lucide's ISC licence (and Feather's MIT, for the icons derived from it)
 * and src/agentKeyPackShards.ts, the loader for each drawings file.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [repoDir, staticDir] = process.argv.slice(2);
if (!repoDir || !staticDir) {
  console.error('usage: node scripts/agent-key-pack.mjs <lucide repo> <lucide-static package>');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'packages/companion-protocol/src/agent-key-pack');
const version = JSON.parse(readFileSync(join(staticDir, 'package.json'), 'utf8')).version;
const nodes = JSON.parse(readFileSync(join(staticDir, 'icon-nodes.json'), 'utf8'));

const n = (v) => {
  const x = Math.round(Number(v) * 1000) / 1000;
  return String(x);
};

/** One SVG element as path data (circles are kept as circles). */
function toPath(tag, a) {
  switch (tag) {
    case 'path':
      return a.d;
    case 'line':
      return `M${n(a.x1)} ${n(a.y1)}L${n(a.x2)} ${n(a.y2)}`;
    case 'polyline':
    case 'polygon': {
      const pts = a.points.trim().split(/[\s,]+/).map(Number);
      let d = '';
      for (let i = 0; i < pts.length; i += 2) d += `${i ? 'L' : 'M'}${n(pts[i])} ${n(pts[i + 1])}`;
      return tag === 'polygon' ? `${d}Z` : d;
    }
    case 'ellipse': {
      const [cx, cy, rx, ry] = [a.cx, a.cy, a.rx, a.ry].map(Number);
      return (
        `M${n(cx - rx)} ${n(cy)}A${n(rx)} ${n(ry)} 0 1 0 ${n(cx + rx)} ${n(cy)}` +
        `A${n(rx)} ${n(ry)} 0 1 0 ${n(cx - rx)} ${n(cy)}Z`
      );
    }
    case 'rect': {
      const x = Number(a.x ?? 0);
      const y = Number(a.y ?? 0);
      const w = Number(a.width);
      const h = Number(a.height);
      let rx = Number(a.rx ?? a.ry ?? 0);
      let ry = Number(a.ry ?? a.rx ?? 0);
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`;
      const arc = (ex, ey) => `A${n(rx)} ${n(ry)} 0 0 1 ${n(ex)} ${n(ey)}`;
      return (
        `M${n(x + rx)} ${n(y)}H${n(x + w - rx)}${arc(x + w, y + ry)}` +
        `V${n(y + h - ry)}${arc(x + w - rx, y + h)}H${n(x + rx)}${arc(x, y + h - ry)}` +
        `V${n(y + ry)}${arc(x + rx, y)}Z`
      );
    }
    default:
      throw new Error(`unknown element <${tag}>`);
  }
}

function drawing(elements) {
  const paths = [];
  const circles = [];
  for (const [tag, a] of elements) {
    if (tag === 'circle') circles.push([Number(a.cx), Number(a.cy), Number(a.r)]);
    else paths.push(toPath(tag, a));
  }
  return circles.length ? { paths, circles } : { paths };
}

const catFiles = readdirSync(join(repoDir, 'categories')).filter((f) => f.endsWith('.json'));
const categories = catFiles
  .map((f) => [basename(f, '.json'), JSON.parse(readFileSync(join(repoDir, 'categories', f))).title])
  .sort((a, b) => a[0].localeCompare(b[0]));
const catIndex = new Map(categories.map(([id], i) => [id, i]));

const names = Object.keys(nodes).sort();
const icons = [];
const shards = new Map();
for (const name of names) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error(`odd icon name ${name}`);
  const meta = JSON.parse(readFileSync(join(repoDir, 'icons', `${name}.json`), 'utf8'));
  const tags = [...new Set((meta.tags ?? []).map((t) => String(t).toLowerCase().trim()))];
  const cats = (meta.categories ?? []).filter((c) => catIndex.has(c)).map((c) => catIndex.get(c));
  icons.push([name, tags.join(','), cats]);
  const shard = name[0];
  if (!shards.has(shard)) shards.set(shard, {});
  shards.get(shard)[name] = drawing(nodes[name]);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const index = {
  $comment:
    'Generated by scripts/agent-key-pack.mjs from Lucide (ISC, see LICENSE here): the icons an agent key can wear beyond the featured legends. icons: [name, comma-separated tags, category indexes]. Ids are "lucide:" + name.',
  pack: 'Lucide',
  version,
  categories,
  icons,
};
writeFileSync(join(out, 'index.json'), `${JSON.stringify(index)}\n`);
for (const [shard, map] of shards) {
  writeFileSync(join(out, `drawings-${shard}.json`), `${JSON.stringify(map)}\n`);
}
writeFileSync(join(out, 'LICENSE'), readFileSync(join(staticDir, 'LICENSE'), 'utf8'));

const loaders = [...shards.keys()]
  .sort()
  .map((s) => `  '${s}': () => import('./agent-key-pack/drawings-${s}.json'),`)
  .join('\n');
writeFileSync(
  join(root, 'packages/companion-protocol/src/agentKeyPackShards.ts'),
  `// Generated by scripts/agent-key-pack.mjs: one loader per drawings file, so a
// client reads only the file an icon is in (agentKeyPack.ts).
/* eslint-disable */

/** A drawings file: each icon's name to its drawing (read through agentKeyPack.ts). */
type Shard = Promise<unknown>;

export const PACK_SHARDS: Record<string, () => Shard> = {
${loaders}
};

/** The search index: every icon's name, tags and categories. */
export const PACK_INDEX = (): Promise<unknown> => import('./agent-key-pack/index.json');
`
);
const requires = [...shards.keys()]
  .sort()
  .map(
    (s) =>
      `  '${s}': () => Promise.resolve(require('./agent-key-pack/drawings-${s}.json') as unknown),`
  )
  .join('\n');
writeFileSync(
  join(root, 'packages/companion-protocol/src/agentKeyPackShards.require.ts'),
  `// Generated by scripts/agent-key-pack.mjs: the phone's loaders. Metro (and the
// phone's Jest) resolve ./agentKeyPackShards to this file (mobile/metro.config.js):
// Metro doesn't split bundles for import(), so each drawings file is a module in
// the bundle, required (and so evaluated) only the first time it's needed.
/* eslint-disable */

declare const require: (id: string) => unknown;

export const PACK_SHARDS: Record<string, () => Promise<unknown>> = {
${requires}
};

/** The search index: every icon's name, tags and categories. */
export const PACK_INDEX = (): Promise<unknown> =>
  Promise.resolve(require('./agent-key-pack/index.json') as unknown);
`
);
console.log(`Lucide ${version}: ${icons.length} icons, ${categories.length} categories, ${shards.size} drawing files`);
