#!/usr/bin/env node
/**
 * The app icon, for the desk and the phone, from one drawing.
 *
 * The mark is the site's: the "M" (a dome with two slot eyes) on a Graphite
 * agent key (docs/internal/agent-keys.md): three shades of one hue (face,
 * skirt, depth), a hard depth band, the cream legend. The light Dock option is
 * the same key in the site's putty (`.key` in the site's global.css).
 *
 * The drawing lives here, as numbers, and is written out as SVG sources in
 * `src-tauri/icons/source/` so it can be opened and inspected. Everything else
 * is rasterised from those files with headless Chrome (the browser the UI
 * harness already drives; no new dependency), then:
 *
 *   src-tauri/icons/*              desktop sizes, .ico (`tauri icon`) and .icns
 *                                  (iconutil, with hand-tuned 16 and 32 px art)
 *   src-tauri/icons/ios, android   Tauri's mobile sets, from the full-bleed art
 *   src-tauri/icons/tray/*         the menu-bar template (black, tinted by macOS)
 *   public/app-icon-{dark,light}   the Dock icon options (Settings → Dock icon)
 *   public/favicon.png
 *   mobile/assets/*                the companion app: icon (full bleed, opaque),
 *                                  iOS dark + tinted, Android adaptive foreground,
 *                                  splash, notification, web favicon
 *
 *   pnpm icons:build                 everything
 *   pnpm icons:build -- --sheet <png>   also a review sheet (sizes, Dock, Home Screen)
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'src-tauri/icons/source');
const TRAY = path.join(ROOT, 'src-tauri/icons/tray');
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));

// ── palette (agent-keys.md "Graphite"; the site's putty .key for light) ──────
const GRAPHITE = {
  faceTop: '#5c6067',
  face: '#4A4E55',
  faceBot: '#464a51',
  faceHi: '#7d8188',
  skirtTop: '#45484e',
  skirt: '#34373C',
  skirtBot: '#2c2f33',
  skirtHi: '#5a5d63',
  lip: '#2a2d31',
  depth: '#131417',
  legend: '#F2EEE4',
  legendBot: '#e9e3d6',
};
const PUTTY = {
  faceTop: '#fffefb',
  face: '#f7f4ee',
  faceBot: '#f1ede5',
  faceHi: '#ffffff',
  skirtTop: '#efe9de',
  skirt: '#e1dacb',
  skirtBot: '#d3cab8',
  skirtHi: '#f7f3eb',
  lip: '#cbc1ad',
  depth: '#b3a891',
  legend: '#1d1c1a',
  legendBot: '#1d1c1a',
};

// ── the mark (the site's agent-icons.ts `mark`, 96-unit grid) ─────────────────
const GLYPH =
  'M39,12 H57 C75.6,12 87,23.4 87,42 V75 C87,80.58 83.58,84 78,84 H18 C12.42,84 9,80.58 9,75 V42 C9,23.4 20.4,12 39,12 Z ' +
  'M27,75 V39 A6,6 0 0 1 39,39 V75 Z M57,75 V39 A6,6 0 0 1 69,39 V75 Z';
const GLYPH_BOX = { x: 9, y: 12, w: 78, h: 72 };

/** The glyph scaled to `w` wide, centred on (cx, cy). */
function glyph(cx, cy, w, fill) {
  const s = w / GLYPH_BOX.w;
  const tx = cx - (GLYPH_BOX.x + GLYPH_BOX.w / 2) * s;
  const ty = cy - (GLYPH_BOX.y + GLYPH_BOX.h / 2) * s;
  return `<path transform="translate(${r2(tx)} ${r2(ty)}) scale(${r4(s)})" fill="${fill}" fill-rule="evenodd" d="${GLYPH}"/>`;
}

// ── shapes ───────────────────────────────────────────────────────────────────
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;

/**
 * A rounded rectangle with Apple's continuous ("squircle") corners: the curve
 * UIBezierPath draws for `roundedRect:cornerRadius:`, which is the corner the
 * macOS icon template uses. `r` is the nominal radius.
 */
function squircle(x, y, w, h, r) {
  r = Math.min(r, Math.min(w, h) / 2 / 1.52866483);
  const X = x + w,
    Y = y + h;
  const p = (a, b) => `${r2(a)},${r2(b)}`;
  const k = [1.52866483, 1.08849323, 0.86840689, 0.63149399, 0.07491139, 0.37282392, 0.16906013];
  const [a, b, c, d, e, f, g] = k.map((v) => v * r);
  return [
    `M${p(x + a, y)}`,
    `L${p(X - a, y)}`,
    `C${p(X - b, y)} ${p(X - c, y)} ${p(X - d, y + e)}`,
    `C${p(X - f, y + g)} ${p(X - g, y + f)} ${p(X - e, y + d)}`,
    `C${p(X, y + c)} ${p(X, y + b)} ${p(X, y + a)}`,
    `L${p(X, Y - a)}`,
    `C${p(X, Y - b)} ${p(X, Y - c)} ${p(X - e, Y - d)}`,
    `C${p(X - g, Y - f)} ${p(X - f, Y - g)} ${p(X - d, Y - e)}`,
    `C${p(X - c, Y)} ${p(X - b, Y)} ${p(X - a, Y)}`,
    `L${p(x + a, Y)}`,
    `C${p(x + b, Y)} ${p(x + c, Y)} ${p(x + d, Y - e)}`,
    `C${p(x + f, Y - g)} ${p(x + g, Y - f)} ${p(x + e, Y - d)}`,
    `C${p(x, Y - c)} ${p(x, Y - b)} ${p(x, Y - a)}`,
    `L${p(x, y + a)}`,
    `C${p(x, y + b)} ${p(x, y + c)} ${p(x + e, y + d)}`,
    `C${p(x + g, y + f)} ${p(x + f, y + g)} ${p(x + d, y + e)}`,
    `C${p(x + c, y)} ${p(x + b, y)} ${p(x + a, y)}`,
    'Z',
  ].join(' ');
}

/**
 * One key inside the box (x, y, s × s): depth band, skirt, face, legend.
 * Proportions follow the site's favicon and AgentKey: depth ~6.5%, side
 * walls ~6.5%, top lip ~2%, front band ~13%, legend ~56% of the face.
 */
function key(id, { x, y, s, r, c, outline = true, glyphScale = 0.56, square = false }) {
  const depth = s * 0.066;
  const side = s * 0.066;
  const top = s * 0.02;
  const front = s * 0.128;
  const skirtH = s - depth;
  const fx = x + side,
    fy = y + top,
    fw = s - side * 2,
    fh = skirtH - top - front;
  const fr = Math.max(4, r - side * 0.9);
  const body = square ? `M${x},${y} h${s} v${s} h${-s} Z` : squircle(x, y, s, s, r);
  const skirt = square ? `M${x},${y} h${s} v${r2(skirtH)} h${-s} Z` : squircle(x, y, s, skirtH, r);
  const face = squircle(fx, fy, fw, fh, fr);
  const hair = s / 1024;
  return `
  <defs>
    <linearGradient id="${id}-skirt" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.skirtTop}"/><stop offset=".42" stop-color="${c.skirt}"/><stop offset="1" stop-color="${c.skirtBot}"/>
    </linearGradient>
    <linearGradient id="${id}-walls" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000" stop-opacity=".14"/><stop offset=".07" stop-color="#000" stop-opacity=".05"/><stop offset=".22" stop-color="#000" stop-opacity="0"/>
      <stop offset=".78" stop-color="#000" stop-opacity="0"/><stop offset=".93" stop-color="#000" stop-opacity=".05"/><stop offset="1" stop-color="#000" stop-opacity=".14"/>
    </linearGradient>
    <linearGradient id="${id}-face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.faceTop}"/><stop offset=".55" stop-color="${c.face}"/><stop offset="1" stop-color="${c.faceBot}"/>
    </linearGradient>
    <linearGradient id="${id}-legend" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.legend}"/><stop offset="1" stop-color="${c.legendBot}"/>
    </linearGradient>
    <clipPath id="${id}-body"><path d="${body}"/></clipPath>
    <clipPath id="${id}-skirtclip"><path d="${skirt}"/></clipPath>
    <clipPath id="${id}-faceclip"><path d="${face}"/></clipPath>
  </defs>
  <g clip-path="url(#${id}-body)">
    <path d="${body}" fill="${c.depth}"/>
    <path d="${skirt}" fill="url(#${id}-skirt)"/>
    <g clip-path="url(#${id}-skirtclip)">
      <rect x="${x}" y="${y}" width="${s}" height="${s}" fill="url(#${id}-walls)"/>
      ${outline ? `<path d="${skirt}" fill="none" stroke="${c.skirtHi}" stroke-opacity=".7" stroke-width="${r2(hair * 6)}" transform="translate(0 ${r2(hair * 3)})" clip-path="url(#${id}-skirtclip)"/>` : ''}
    </g>
    <path d="${face}" fill="${c.lip}" transform="translate(0 ${r2(hair * 5)})"/>
    <path d="${face}" fill="url(#${id}-face)"/>
    <g clip-path="url(#${id}-faceclip)">
      <path d="${face}" fill="none" stroke="${c.faceHi}" stroke-opacity=".55" stroke-width="${r2(hair * 6)}" transform="translate(0 ${r2(hair * 3)})"/>
    </g>
    ${glyph(fx + fw / 2, fy + fh / 2 + fh * 0.01, fw * glyphScale, `url(#${id}-legend)`)}
  </g>`;
}

const svg = (size, body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024"${extra}>${body}\n</svg>\n`;

// ── the sources ──────────────────────────────────────────────────────────────

/** macOS: the 824 px body on the 1024 grid (100 px margin), Apple's ~185 px corner, a soft drop shadow. */
function macIcon(c) {
  return svg(
    1024,
    `
  <defs>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="12"/>
      <feComponentTransfer><feFuncA type="linear" slope=".32"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <g filter="url(#drop)">${key('k', { x: 100, y: 100, s: 824, r: 185, c })}
  </g>`
  );
}

/**
 * The mark redrawn on a pixel grid: every vertical edge on a whole pixel, so
 * the two eyes stay sharp at sizes where the scaled glyph would blur them
 * into grey. Same proportions as the glyph (sides : eyes : middle ≈ 3 : 2 : 3).
 * Units are device pixels; `u` scales them into the drawing.
 */
function pixelGlyph(x, y, { side, eye, mid, h, bar, eyeTop, R }, u = 1) {
  const w = side * 2 + eye * 2 + mid;
  const er = eye / 2;
  const P = (a, b) => `${r2(a * u)},${r2(b * u)}`;
  const slot = (sx) =>
    `M${P(sx, y + h - bar)} V${r2((y + eyeTop + er) * u)} A${r2(er * u)},${r2(er * u)} 0 0 1 ${P(sx + eye, y + eyeTop + er)} V${r2((y + h - bar) * u)} Z`;
  return (
    `M${P(x + R, y)} H${r2((x + w - R) * u)} A${r2(R * u)},${r2(R * u)} 0 0 1 ${P(x + w, y + R)} ` +
    `V${r2((y + h) * u)} H${r2(x * u)} V${r2((y + R) * u)} A${r2(R * u)},${r2(R * u)} 0 0 1 ${P(x + R, y)} Z ` +
    slot(x + side) +
    ' ' +
    slot(x + side + eye + mid)
  );
}

/**
 * The 16 and 32 px Finder sizes, drawn for their pixels rather than shrunk:
 * the body fills more of the grid, the depth and front band are whole pixels
 * and the legend is the pixel-grid mark, so the M and its two eyes survive.
 */
function macSmall(px, c) {
  const u = 1024 / px; // one device pixel in viewBox units
  const g =
    px <= 16
      ? {
          inset: 1,
          depth: 1,
          front: 2,
          gx: 4,
          gy: 3,
          m: { side: 2, eye: 1, mid: 2, h: 7, bar: 1, eyeTop: 2, R: 3 },
        }
      : {
          inset: 2,
          depth: 2,
          front: 3,
          gx: 7,
          gy: 5,
          m: { side: 4, eye: 3, mid: 4, h: 16, bar: 2, eyeTop: 5, R: 7 },
        };
  const s = px - g.inset * 2;
  const r = s * 0.225;
  const x = g.inset,
    y = g.inset;
  const fx = x + 1,
    fw = s - 2,
    fh = s - g.depth - g.front;
  return svg(
    1024,
    `
  <path d="${squircle(x * u, y * u, s * u, s * u, r * u)}" fill="${c.depth}"/>
  <path d="${squircle(x * u, y * u, s * u, (s - g.depth) * u, r * u)}" fill="${c.skirt}"/>
  <path d="${squircle(fx * u, y * u, fw * u, fh * u, (r - 1) * u)}" fill="${c.face}"/>
  <path fill="${c.legend}" fill-rule="evenodd" d="${pixelGlyph(g.gx, g.gy, g.m, u)}"/>`
  );
}

/** iOS: full bleed, opaque, square (iOS applies its own corner mask). */
function iosIcon(c) {
  return svg(1024, key('k', { x: 0, y: 0, s: 1024, r: 229, c, square: true, glyphScale: 0.54 }));
}

/**
 * Android adaptive foreground: a 108 dp canvas whose middle 72 dp is what most
 * masks show. The iOS composition fills that middle; the skirt and depth carry
 * on to the edges so a launcher's parallax never shows a seam.
 */
function androidForeground(c) {
  const inner = 1024 * (72 / 108);
  const o = (1024 - inner) / 2;
  const depthTop = o + inner * (1 - 0.066);
  return svg(
    1024,
    `
  <rect width="1024" height="${r2(depthTop)}" fill="${c.skirt}"/>
  <rect y="${r2(depthTop)}" width="1024" height="${r2(1024 - depthTop)}" fill="${c.depth}"/>
  <g transform="translate(${r2(o)} ${r2(o)}) scale(${r4(inner / 1024)})">${key('k', { x: 0, y: 0, s: 1024, r: 229, c, square: true, glyphScale: 0.54 })}
  </g>`
  );
}

/** The mark alone, centred, on transparent: iOS dark and tinted, notifications. */
const glyphOnly = (fill, w = 560) => svg(1024, glyph(512, 512, w, fill));

/** The splash: the key as an object (no grid margin, no shadow), on transparent. */
const splash = (c) => svg(1024, key('k', { x: 0, y: 0, s: 1024, r: 230, c }));

/**
 * Menu bar: a template image, black on transparent, 18 pt (36 px at 2x). The
 * mark alone: the key's shading can't survive a one-colour 18 pt image, the
 * dome and its two eyes can.
 */
function tray(attention) {
  const d = pixelGlyph(4, 5, { side: 6, eye: 5, mid: 6, h: 26, bar: 3, eyeTop: 8, R: 11 });
  return `<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
  <!-- The mark as a macOS template (scripts/build-icons.mjs)${attention ? ', with a dot at the top right: something needs you' : ''}. -->
${attention ? '  <defs><mask id="cut"><rect width="36" height="36" fill="#fff"/><circle cx="30" cy="6" r="7.5" fill="#000"/></mask></defs>\n' : ''}  <path${attention ? ' mask="url(#cut)"' : ''} fill="#000" fill-rule="evenodd" d="${d}"/>
${attention ? '  <circle cx="30" cy="6" r="5.5" fill="#000"/>\n' : ''}</svg>
`;
}

// ── rasterising ──────────────────────────────────────────────────────────────

function render(src, out, px, { pageSize } = {}) {
  if (!CHROME) throw new Error('build-icons: no Chrome found (set CHROME_PATH)');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'icon-'));
  const file = path.join(tmp, 'i.svg');
  // Draw the vector at the target size, so small sizes are rasterised, not downsampled.
  const text = typeof src === 'string' && src.startsWith('<') ? src : readSvg(src);
  writeFileSync(file, text.replace(/width="\d+" height="\d+"/, `width="${px}" height="${px}"`));
  const size = pageSize ?? px;
  const run = spawnSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      '--force-device-scale-factor=1',
      `--user-data-dir=${path.join(tmp, 'profile')}`,
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      pathToFileURL(file).href,
    ],
    { stdio: 'pipe' }
  );
  rmSync(tmp, { recursive: true, force: true });
  if (run.status !== 0 || !existsSync(out))
    throw new Error(`build-icons: ${out} failed\n${run.stderr}`);
}

const readSvg = (name) => sources[name];
const sources = {};

function write(name, text) {
  sources[name] = text;
  writeFileSync(path.join(SOURCE, name), text);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) throw new Error(`build-icons: ${cmd} ${args.join(' ')} failed`);
}

/** An opaque PNG (iOS rejects an app icon with an alpha channel). */
function flatten(file, colour) {
  if (spawnSync('magick', ['-version']).status === 0) {
    run('magick', [file, '-background', colour, '-alpha', 'remove', '-alpha', 'off', file]);
  } else {
    // sips writes JPEG-then-PNG without alpha; the art is opaque already, this only drops the channel.
    const jpg = file.replace(/\.png$/, '.jpg');
    run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', file, '--out', jpg], {
      stdio: 'pipe',
    });
    run('sips', ['-s', 'format', 'png', jpg, '--out', file], { stdio: 'pipe' });
    rmSync(jpg);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const sheetAt = process.argv.indexOf('--sheet');
  mkdirSync(SOURCE, { recursive: true });

  write('mac.svg', macIcon(GRAPHITE));
  write('mac-light.svg', macIcon(PUTTY));
  write('mac-16.svg', macSmall(16, GRAPHITE));
  write('mac-32.svg', macSmall(32, GRAPHITE));
  write('ios.svg', iosIcon(GRAPHITE));
  write('android-foreground.svg', androidForeground(GRAPHITE));
  write('mark-cream.svg', glyphOnly(GRAPHITE.legend));
  write('mark-white.svg', glyphOnly('#ffffff'));
  write('splash.svg', splash(GRAPHITE));
  writeFileSync(path.join(TRAY, 'tray.svg'), tray(false));
  writeFileSync(path.join(TRAY, 'tray-attention.svg'), tray(true));

  const work = mkdtempSync(path.join(os.tmpdir(), 'icons-'));
  try {
    const mac1024 = path.join(work, 'mac-1024.png');
    const ios1024 = path.join(work, 'ios-1024.png');
    render('mac.svg', mac1024, 1024);
    render('ios.svg', ios1024, 1024);

    // Desktop: every size Tauri bundles, plus its mobile sets from the full-bleed art.
    const desk = path.join(work, 'desk');
    run('pnpm', ['exec', 'tauri', 'icon', mac1024, '-o', desk], { stdio: 'pipe' });
    const mobileSets = path.join(work, 'tauri-mobile');
    run('pnpm', ['exec', 'tauri', 'icon', ios1024, '-o', mobileSets], { stdio: 'pipe' });
    const icons = path.join(ROOT, 'src-tauri/icons');
    for (const f of readdirSync(desk)) {
      if (f.endsWith('.png') || f === 'icon.ico')
        copyFileSync(path.join(desk, f), path.join(icons, f));
    }
    for (const set of ['ios', 'android'])
      run('cp', ['-R', path.join(mobileSets, set) + '/.', path.join(icons, set)]);

    // The hand-drawn small sizes go into the .icns and the 32 px PNG.
    const iconset = path.join(work, 'icon.iconset');
    mkdirSync(iconset);
    const sizes = [16, 32, 64, 128, 256, 512, 1024];
    for (const px of sizes) {
      const src = px === 16 ? 'mac-16.svg' : px === 32 ? 'mac-32.svg' : 'mac.svg';
      render(src, path.join(work, `mac-${px}.png`), px);
    }
    const pairs = [
      ['16x16', 16],
      ['16x16@2x', 32],
      ['32x32', 32],
      ['32x32@2x', 64],
      ['128x128', 128],
      ['128x128@2x', 256],
      ['256x256', 256],
      ['256x256@2x', 512],
      ['512x512', 512],
      ['512x512@2x', 1024],
    ];
    for (const [name, px] of pairs)
      copyFileSync(path.join(work, `mac-${px}.png`), path.join(iconset, `icon_${name}.png`));
    if (process.platform === 'darwin') {
      run('iconutil', ['-c', 'icns', iconset, '-o', path.join(icons, 'icon.icns')]);
    } else {
      copyFileSync(path.join(desk, 'icon.icns'), path.join(icons, 'icon.icns'));
    }
    copyFileSync(path.join(work, 'mac-32.png'), path.join(icons, '32x32.png'));

    // Menu bar.
    render(tray(false), path.join(TRAY, 'tray.png'), 36);
    render(tray(true), path.join(TRAY, 'tray-attention.png'), 36);

    // In-app: the Dock icon options and the favicon.
    render('mac.svg', path.join(ROOT, 'public/app-icon-dark.png'), 512);
    render('mac-light.svg', path.join(ROOT, 'public/app-icon-light.png'), 512);
    render('mac.svg', path.join(ROOT, 'public/favicon.png'), 64);

    // Phone.
    const m = (f) => path.join(ROOT, 'mobile/assets', f);
    copyFileSync(ios1024, m('icon.png'));
    flatten(m('icon.png'), GRAPHITE.skirt);
    render('mark-cream.svg', m('icon-dark.png'), 1024);
    render('mark-white.svg', m('icon-tinted.png'), 1024);
    render('android-foreground.svg', m('adaptive-icon.png'), 1024);
    render('splash.svg', m('splash-icon.png'), 1024);
    render(glyphOnly('#ffffff', 760), m('notification-icon.png'), 96);
    render('mac.svg', m('favicon.png'), 48);

    if (sheetAt > 0) sheet(process.argv[sheetAt + 1], work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log('build-icons: done');
}

/** A review sheet: the icon at 16–512 on light and dark, in a Dock, on a Home Screen. */
function sheet(out, work) {
  if (!out) throw new Error('build-icons: --sheet needs an output path');
  const u = (f) => pathToFileURL(f).href;
  const A = (f) => u(path.join(ROOT, f));
  const rows = [16, 32, 64, 128, 512];
  const strip = (bg, fg) => `
    <div class="strip" style="background:${bg};color:${fg}">
      ${rows.map((px) => `<figure><img src="${u(path.join(work, `mac-${px}.png`))}" style="width:${px}px;height:${px}px"><figcaption>${px}</figcaption></figure>`).join('')}
      <figure><img class="px" src="${u(path.join(work, 'mac-16.png'))}"><figcaption>16 @1x ×4</figcaption></figure>
      <figure><img class="px" src="${u(path.join(work, 'mac-32.png'))}" style="width:128px;height:128px"><figcaption>32 @1x ×4</figcaption></figure>
    </div>`;
  const other = (hue) =>
    `<span class="other" style="background:linear-gradient(hsl(${hue} 55% 62%),hsl(${hue} 50% 44%))"></span>`;
  const ios = (hue, label) =>
    `<figure><span class="ios other" style="background:linear-gradient(hsl(${hue} 60% 60%),hsl(${hue} 55% 45%))"></span><figcaption>${label}</figcaption></figure>`;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;font:13px/1.3 -apple-system,system-ui,sans-serif;background:#e9e4da;width:1300px}
    h2{font-size:13px;font-weight:600;margin:24px 24px 8px;color:#1d1c1a}
    .strip{display:flex;align-items:flex-end;gap:32px;padding:24px;margin:0 24px;border-radius:14px}
    figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:8px}
    figcaption{font-size:11px;opacity:.6}
    .px{width:64px;height:64px;image-rendering:pixelated}
    .ctx{display:flex;gap:24px;margin:0 24px 24px}
    .desk{flex:1.3;height:330px;border-radius:14px;position:relative;overflow:hidden;background:radial-gradient(120% 90% at 20% 0%,#f1b98a,#b7697a 45%,#3a3157)}
    .dock{position:absolute;left:50%;bottom:14px;translate:-50% 0;display:flex;gap:8px;align-items:flex-end;padding:8px 10px;border-radius:24px;background:#ffffff40;backdrop-filter:blur(20px);box-shadow:inset 0 0 0 1px #ffffff40}
    .dock img,.dock .other{width:68px;height:68px}
    .dock .other{display:block;width:56px;height:56px;margin:6px;border-radius:13px;box-shadow:0 2px 4px #0003}
    .dock .dot{position:absolute;bottom:3px;width:4px;height:4px;border-radius:50%;background:#000a}
    .menubar{position:absolute;inset:0 0 auto;height:28px;display:flex;align-items:center;justify-content:flex-end;gap:14px;padding:0 14px;background:#ffffff59;backdrop-filter:blur(20px)}
    .menubar.dark{top:40px;background:#1e1e1ecc}
    .menubar img{width:18px;height:18px}
    .menubar.dark img{filter:invert(1)}
    .phone{width:340px;height:330px;border-radius:14px;overflow:hidden;padding:26px 22px;box-sizing:border-box;display:grid;grid-template-columns:repeat(4,1fr);gap:18px 10px;align-content:start;background:linear-gradient(160deg,#20304a,#5b4a6e 60%,#c58b7a);color:#fff}
    .phone img,.phone .ios{width:62px;height:62px;border-radius:14px;display:block}
    .phone figcaption{opacity:1;font-size:11px}
    .phone.light{background:linear-gradient(160deg,#f3e9dc,#d7c9e6 60%,#bcd3e8);color:#1d1c1a}
  </style>
  <h2>Desktop icon at its real pixel sizes (16 and 32 are the hand-tuned art), light and dark</h2>${strip('#faf8f4', '#1d1c1a')}<h2></h2>${strip('#1e1e1e', '#f2eee4')}
  <h2>Dock, menu bar (template, light and dark), and the phone's Home Screen (iOS masks the full-bleed square)</h2>
  <div class="ctx">
    <div class="desk">
      <div class="menubar"><img src="${A('src-tauri/icons/tray/tray-attention.png')}"><img src="${A('src-tauri/icons/tray/tray.png')}"><span>Mon 9 Nov 10:41</span></div>
      <div class="menubar dark" style="color:#fff"><img src="${A('src-tauri/icons/tray/tray-attention.png')}"><img src="${A('src-tauri/icons/tray/tray.png')}"><span>Mon 9 Nov 10:41</span></div>
      <div class="dock">${other(210)}${other(140)}${other(30)}<span style="position:relative;display:flex;justify-content:center"><img src="${u(path.join(work, 'mac-256.png'))}"><i class="dot"></i></span>${other(0)}<span style="position:relative;display:flex;justify-content:center"><img src="${A('public/app-icon-light.png')}"></span>${other(270)}</div>
    </div>
    <div class="phone">${ios(205, 'Mail')}${ios(120, 'Maps')}<figure><img src="${A('mobile/assets/icon.png')}"><figcaption>Mogbot</figcaption></figure>${ios(35, 'Notes')}${ios(0, 'Music')}${ios(260, 'Podcasts')}${ios(180, 'Files')}${ios(50, 'Photos')}</div>
    <div class="phone light">${ios(205, 'Mail')}${ios(120, 'Maps')}<figure><img src="${A('mobile/assets/icon.png')}"><figcaption>Mogbot</figcaption></figure>${ios(35, 'Notes')}${ios(0, 'Music')}${ios(260, 'Podcasts')}${ios(180, 'Files')}${ios(50, 'Photos')}</div>
  </div>
  <h2>Phone extras: iOS dark, tinted, Android adaptive (circle and squircle masks), splash, notification</h2>
  <div class="strip" style="background:#151413;color:#f2eee4;margin-bottom:24px">
    <figure><img src="${A('mobile/assets/icon-dark.png')}" style="width:96px;height:96px;border-radius:22px;background:linear-gradient(#2a2a2c,#111)"><figcaption>iOS dark</figcaption></figure>
    <figure><img src="${A('mobile/assets/icon-tinted.png')}" style="width:96px;height:96px;border-radius:22px;background:linear-gradient(#3b2a14,#120c05);filter:sepia(1) saturate(3) hue-rotate(-10deg)"><figcaption>iOS tinted</figcaption></figure>
    <figure><span style="width:96px;height:96px;border-radius:50%;overflow:hidden;display:block;background:#151413"><img src="${A('mobile/assets/adaptive-icon.png')}" style="width:144px;height:144px;margin:-24px"></span><figcaption>Android circle</figcaption></figure>
    <figure><span style="width:96px;height:96px;border-radius:28px;overflow:hidden;display:block;background:#151413"><img src="${A('mobile/assets/adaptive-icon.png')}" style="width:144px;height:144px;margin:-24px"></span><figcaption>Android squircle</figcaption></figure>
    <figure><span style="width:96px;height:96px;display:grid;place-items:center;background:#faf8f4;border-radius:12px"><img src="${A('mobile/assets/splash-icon.png')}" style="width:64px;height:64px"></span><figcaption>splash (light)</figcaption></figure>
    <figure><img src="${A('mobile/assets/notification-icon.png')}" style="width:48px;height:48px"><figcaption>notification</figcaption></figure>
  </div>`;
  const page = path.join(work, 'sheet.html');
  writeFileSync(page, html);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sheet-'));
  const r = spawnSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--user-data-dir=${tmp}`,
      '--window-size=1300,1890',
      `--screenshot=${path.resolve(out)}`,
      u(page),
    ],
    { stdio: 'pipe' }
  );
  rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) throw new Error('build-icons: sheet failed');
  console.log(`build-icons: sheet ${out}`);
}

main();
