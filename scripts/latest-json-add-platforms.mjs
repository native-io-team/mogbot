#!/usr/bin/env node
// Adds the Windows and Linux update entries to a release's latest.json, from
// the installers a build-installers.yml run made (downloaded with
// `gh run download <id> -D <dir>`). Writes nothing anywhere else and uploads
// nothing: attaching the files and the new latest.json is a separate step.
//
//   node scripts/latest-json-add-platforms.mjs <latest.json> <download dir> <tag>
//
// Each platform gets an entry only when its update bundle *and* signature are
// there (the run had TAURI_SIGNING_PRIVATE_KEY); otherwise it is left out and
// said, so an installed copy on that platform simply finds no update.
import fs from 'node:fs';
import path from 'node:path';

const [latestPath, dir, tag] = process.argv.slice(2);
if (!latestPath || !dir || !tag) {
  console.error('usage: latest-json-add-platforms.mjs <latest.json> <download dir> <tag>');
  process.exit(2);
}
const brand = JSON.parse(fs.readFileSync(new URL('../brand.json', import.meta.url), 'utf8'));
const releases = String(brand.links?.releases ?? '').replace(/\/$/, '');
if (!releases) {
  console.error('brand.json has no links.releases');
  process.exit(1);
}

// Tauri's updater platform keys, and which bundle each one updates from.
const TARGETS = [
  { key: 'windows-x86_64', artifact: 'windows-x86_64', suffix: '-setup.exe' },
  { key: 'linux-x86_64', artifact: 'linux-x86_64', suffix: '.AppImage' },
  { key: 'linux-aarch64', artifact: 'linux-aarch64', suffix: '.AppImage' },
];

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
  );
}

const files = walk(dir);
const manifest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
manifest.platforms ??= {};

for (const t of TARGETS) {
  const bundle = files.find((f) => path.basename(f).endsWith(`_${t.artifact}${t.suffix}`));
  const sig = bundle && files.find((f) => f === `${bundle}.sig`);
  if (!bundle || !sig) {
    console.log(`${t.key}: no signed update bundle in ${dir}, left out`);
    continue;
  }
  manifest.platforms[t.key] = {
    signature: fs.readFileSync(sig, 'utf8').trim(),
    url: `${releases}/download/${tag}/${path.basename(bundle)}`,
  };
  console.log(`${t.key}: ${manifest.platforms[t.key].url}`);
}

fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2) + '\n');
