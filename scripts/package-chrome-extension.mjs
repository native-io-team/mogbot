#!/usr/bin/env node
/**
 * The Chrome Web Store upload: chrome-extension/extension as a zip, with
 * the manifest's `key` removed (the store refuses a manifest that carries
 * one; it gives the listing its own key and id, which then goes into
 * brand.json as chromeExtension.webStoreId). Nothing is uploaded.
 *
 *   node scripts/package-chrome-extension.mjs
 *   → chrome-extension/dist/<slug>-chrome-<version>.zip
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'chrome-extension/extension');
const dist = join(root, 'chrome-extension/dist');
const stage = join(dist, 'stage');
const brand = JSON.parse(readFileSync(join(root, 'brand.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(src, stage, {
  recursive: true,
  filter: (p) => !p.split('/').pop().startsWith('.'),
});
delete manifest.key;
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const out = join(dist, `${brand.slug}-chrome-${manifest.version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, '.'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });
console.log(`Web Store package: ${out.replace(`${root}/`, '')}`);
console.log('Not uploaded. Listing text and privacy answers: chrome-extension/store/.');
