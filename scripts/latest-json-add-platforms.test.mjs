// latest.json must name every installer kind: an installed .deb, .rpm or .msi
// asks for `<os>-<arch>-<kind>` first, and when only the plain key is there it
// is handed the AppImage or the .exe, which its updater refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'latest-json-add-platforms.mjs');
const V = '9.9.9';
const BUNDLES = {
  'windows-x86_64': ['-setup.exe', '.msi'],
  'linux-x86_64': ['.AppImage', '.deb', '.rpm'],
  'linux-aarch64': ['.AppImage', '.deb', '.rpm'],
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-json-'));
  const dir = path.join(root, 'dl');
  for (const [artifact, suffixes] of Object.entries(BUNDLES)) {
    const d = path.join(dir, `installers-${artifact}`);
    fs.mkdirSync(d, { recursive: true });
    for (const s of suffixes) {
      const f = path.join(d, `App_${V}_${artifact}${s}`);
      fs.writeFileSync(f, 'bundle');
      fs.writeFileSync(`${f}.sig`, `sig:${artifact}${s}`);
      fs.writeFileSync(`${f}.sha256`, 'sum');
      // The stable name has no version and must never be picked.
      fs.writeFileSync(path.join(d, `App-${artifact}${s}`), 'stable');
    }
  }
  const latest = path.join(root, 'latest.json');
  fs.writeFileSync(latest, JSON.stringify({ version: V, platforms: { 'darwin-aarch64': {} } }));
  return { dir, latest };
}

const run = (latest, dir) =>
  spawnSync(process.execPath, [script, '--require-all', latest, dir, `v${V}`], { encoding: 'utf8' });

test('every installer kind gets its own signed entry, and the plain keys stay', () => {
  const { dir, latest } = fixture();
  const r = run(latest, dir);
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(fs.readFileSync(latest, 'utf8')).platforms;
  const expect = {
    'windows-x86_64': 'windows-x86_64-setup.exe',
    'windows-x86_64-nsis': 'windows-x86_64-setup.exe',
    'windows-x86_64-msi': 'windows-x86_64.msi',
    'linux-x86_64': 'linux-x86_64.AppImage',
    'linux-x86_64-appimage': 'linux-x86_64.AppImage',
    'linux-x86_64-deb': 'linux-x86_64.deb',
    'linux-x86_64-rpm': 'linux-x86_64.rpm',
    'linux-aarch64': 'linux-aarch64.AppImage',
    'linux-aarch64-appimage': 'linux-aarch64.AppImage',
    'linux-aarch64-deb': 'linux-aarch64.deb',
    'linux-aarch64-rpm': 'linux-aarch64.rpm',
  };
  for (const [key, file] of Object.entries(expect)) {
    assert.ok(p[key], `${key} missing`);
    assert.ok(p[key].url.endsWith(`/download/v${V}/App_${V}_${file}`), `${key}: ${p[key].url}`);
    assert.equal(p[key].signature, `sig:${file}`, key);
  }
  assert.ok(p['darwin-aarch64'], 'the Mac entry is kept');
});

test('--require-all refuses a release missing one kind, and leaves latest.json alone', () => {
  const { dir, latest } = fixture();
  fs.rmSync(path.join(dir, 'installers-linux-x86_64', `App_${V}_linux-x86_64.rpm.sig`));
  const before = fs.readFileSync(latest, 'utf8');
  const r = run(latest, dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /linux-x86_64-rpm/);
  assert.equal(fs.readFileSync(latest, 'utf8'), before);
});
