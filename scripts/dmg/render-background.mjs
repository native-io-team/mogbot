#!/usr/bin/env node
// Renders scripts/dmg/background.html to the DMG window's background:
// background.png (660x420) and background@2x.png, joined by layout.sh into one
// HiDPI TIFF. Uses the Chrome already on this Mac, headless; no packages.
//
//   node scripts/dmg/render-background.mjs [outDir]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const out = path.resolve(process.argv[2] ?? path.join(here, 'out'));
const name = JSON.parse(fs.readFileSync(path.join(root, 'brand.json'), 'utf8')).name;

const chrome = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((p) => p && fs.existsSync(p));
if (!chrome) {
  console.error('No Chrome found (set CHROME=/path/to/chrome).');
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-bg-'));
const html = path.join(tmp, 'background.html');
fs.writeFileSync(
  html,
  fs.readFileSync(path.join(here, 'background.html'), 'utf8').replaceAll('{{NAME}}', name)
);

for (const [scale, file] of [
  [1, 'background.png'],
  [2, 'background@2x.png'],
]) {
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--user-data-dir=${path.join(tmp, 'profile')}`,
      `--force-device-scale-factor=${scale}`,
      '--window-size=660,420',
      `--screenshot=${path.join(out, file)}`,
      `file://${html}`,
    ],
    { stdio: 'ignore' }
  );
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(out);
