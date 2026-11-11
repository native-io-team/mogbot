/*
 * Avatar directions, for choosing between.
 * Each direction is a complete system drawn on one 32-unit grid:
 *   render(variant, hue, px, theme, ctx) -> an <svg> string.
 * Nothing here ships; it exists to make contact sheets.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------- palette
  // Ten hues at one lightness and one chroma per role, per theme (OKLCH), so
  // no agent pops and none sinks. Slate is the one neutral.
  const HUES = {
    red: 25,
    orange: 55,
    amber: 84,
    green: 150,
    teal: 190,
    sky: 232,
    blue: 266,
    violet: 300,
    pink: 350,
    slate: 260,
  };
  const HUE_KEYS = Object.keys(HUES);
  const C = (k, c) => (k === 'slate' ? Math.min(c, 0.018) : c);
  const ok = (l, c, k) => `oklch(${l} ${C(k, c).toFixed(3)} ${HUES[k]})`;

  // Solid: the colour itself.
  const solid = (t, k) => (t === 'dark' ? ok(0.74, 0.12, k) : ok(0.7, 0.13, k));
  // Tonal: a tone of it, and an ink of it.
  const tone = (t, k) => (t === 'dark' ? ok(0.4, 0.07, k) : ok(0.905, 0.045, k));
  const ink = (t, k) => (t === 'dark' ? ok(0.91, 0.06, k) : ok(0.41, 0.1, k));
  // Dark features on a solid colour.
  const deep = (t, k) => ok(0.26, 0.045, k);
  const SURFACE = { dark: '#141414', light: '#f5f5f5' };
  const CONTROL = { dark: '#2a2a2a', light: 'oklch(0.9 0 0)' };

  // ------------------------------------------------------------- helpers
  const r2 = (n) => Math.round(n * 100) / 100;
  let uid = 0;
  const id = (p) => `${p}${++uid}`;
  const svg = (px, body, extra = '') =>
    `<svg width="${px}" height="${px}" viewBox="0 0 32 32" ${extra} style="display:block;overflow:visible">${body}</svg>`;

  /** A superellipse ("squircle") of exponent n. */
  function squircle(n, rx, ry = rx, cx = 16, cy = 16) {
    const steps = 96;
    let d = '';
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const x = cx + rx * Math.sign(c) * Math.abs(c) ** (2 / n);
      const y = cy + ry * Math.sign(s) * Math.abs(s) ** (2 / n);
      d += `${i ? 'L' : 'M'}${r2(x)} ${r2(y)}`;
    }
    return d + 'Z';
  }

  /** A closed smooth curve through points (Catmull-Rom as cubics). */
  function smoothClosed(pts) {
    const n = pts.length;
    let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${r2(c1[0])} ${r2(c1[1])} ${r2(c2[0])} ${r2(c2[1])} ${r2(p2[0])} ${r2(p2[1])}`;
    }
    return d + 'Z';
  }

  /** Grid units for `devicePx` device pixels at this avatar size. */
  const u = (px, devicePx) => (devicePx * 32) / px;
  /** The one line weight: 6.25% of the avatar, never under 1.5 device px. */
  const weight = (px) => Math.max(2, u(px, 1.5));
  /** An eye: a filled oval, never smaller than `minPx` device px across. */
  function eye(cx, cy, rx, ry, px, fill, minPx = 2.2) {
    const k = Math.max(1, u(px, minPx) / (rx * 2));
    return `<ellipse cx="${r2(cx)}" cy="${r2(cy)}" rx="${r2(rx * k)}" ry="${r2(ry * k)}" fill="${fill}"/>`;
  }
  const line = (d, w, stroke) =>
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${r2(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;

  // =================================================================== A
  // One squircle. Identity is the hue; five faces drawn with care.
  const A_SHAPE = squircle(4.6, 14.6);
  const A_FACES = ['Calm', 'Glad', 'Curious', 'Steady', 'Sly'];
  function renderA(v, k, px, t, ctx) {
    const sel = ctx && ctx.selected;
    const fill = sel ? solid(t, k) : tone(t, k);
    const fg = sel ? SURFACE[t] : ink(t, k);
    const w = weight(px);
    const small = px <= 18;
    const E = (dx, dy) =>
      eye(12 + dx, 14.4 + dy, 1.55, 2.05, px, fg) + eye(20 + dx, 14.4 + dy, 1.55, 2.05, px, fg);
    let face = '';
    switch (v % 5) {
      case 0:
        face = E(0, 0) + (small ? '' : line('M13.5 19.6Q16 21.5 18.5 19.6', w, fg));
        break;
      case 1:
        face =
          E(0, 0) +
          (small ? '' : `<path d="M12.6 18.9Q16 19.5 19.4 18.9Q19 23 16 23Q13 23 12.6 18.9Z" fill="${fg}"/>`);
        break;
      case 2:
        face = E(1.1, -0.7) + (small ? '' : `<circle cx="17.3" cy="20.4" r="${r2(w * 0.62)}" fill="${fg}"/>`);
        break;
      case 3:
        face = E(0, 0.2) + (small ? '' : line('M14 20.2H18', w, fg));
        break;
      default:
        face = E(-1, 0) + (small ? '' : line('M12.9 20Q15.4 21.6 18.4 19.1', w, fg));
    }
    return svg(px, `<path d="${A_SHAPE}" fill="${fill}"/>${face}`);
  }

  // =================================================================== B
  // Five siblings on one grid: the same 24-unit body, the same bottom
  // corners, the same face at the same height; only the top differs.
  const B_BOTTOM = 'V23.5A6 6 0 0 1 22 29.5H10A6 6 0 0 1 4 23.5';
  const B_SHAPES = [
    // Gumdrop: a full round top.
    `M4 17A12 12 0 0 1 28 17${B_BOTTOM}Z`,
    // Block: a soft square.
    `M4 12A7.5 7.5 0 0 1 11.5 4.5H20.5A7.5 7.5 0 0 1 28 12${B_BOTTOM}Z`,
    // Bear: two round ears on a soft top.
    `M4 14A6.5 6.5 0 0 1 5.6 9.7A4.3 4.3 0 1 1 12.2 7.1Q16 6.3 19.8 7.1A4.3 4.3 0 1 1 26.4 9.7A6.5 6.5 0 0 1 28 14${B_BOTTOM}Z`,
    // Onion: rises to one soft point.
    `M4 19C4 11.5 11 8.5 14.6 4.4Q16 2.9 17.4 4.4C21 8.5 28 11.5 28 19${B_BOTTOM}Z`,
    // Loaf: wider and lower.
    `M2.5 16.5A9.5 9.5 0 0 1 12 7H20A9.5 9.5 0 0 1 29.5 16.5V23.5A6 6 0 0 1 23.5 29.5H8.5A6 6 0 0 1 2.5 23.5Z`,
  ];
  const B_NAMES = ['Gumdrop', 'Block', 'Bear', 'Onion', 'Loaf'];
  function renderB(v, k, px, t, ctx) {
    const sel = ctx && ctx.selected;
    const fill = sel ? solid(t, k) : tone(t, k);
    const fg = sel ? SURFACE[t] : ink(t, k);
    const w = weight(px);
    const face =
      eye(12.6, 18.6, 1.45, 1.95, px, fg) +
      eye(19.4, 18.6, 1.45, 1.95, px, fg) +
      (px <= 18 ? '' : line('M14.6 22.9Q16 24 17.4 22.9', w * 0.9, fg));
    return svg(px, `<path d="${B_SHAPES[v % 5]}" fill="${fill}"/>${face}`);
  }

  // =================================================================== C
  // A solid disc; the eyes are holes in it. No mouth: the eye shapes are
  // the whole expression, and they still read at 16px.
  const C_NAMES = ['Round', 'Tall', 'Close', 'Glance', 'Odd pair', 'Down'];
  function cEyes(v, px) {
    const k = Math.max(1, u(px, 2.4) / 5); // keep holes open at 16px
    const c = (x, y, r) => `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(r * k)}"/>`;
    const pill = (x, y, w, h) =>
      `<rect x="${r2(x - (w * k) / 2)}" y="${r2(y - (h * k) / 2)}" width="${r2(w * k)}" height="${r2(h * k)}" rx="${r2((Math.min(w, h) * k) / 2)}"/>`;
    switch (v % 6) {
      case 0:
        return c(11.6, 15, 2.6) + c(20.4, 15, 2.6);
      case 1:
        return pill(11.8, 15, 3.6, 6.8) + pill(20.2, 15, 3.6, 6.8);
      case 2:
        return c(12.6, 15.4, 2.1) + c(19.4, 15.4, 2.1);
      case 3:
        return c(13.8, 13.8, 2.5) + c(22, 13.8, 2.5);
      case 4:
        return c(11.4, 15.2, 3.2) + c(20.6, 14.6, 2.2);
      default:
        return c(10.6, 17.2, 2.4) + c(18.6, 17.2, 2.4);
    }
  }
  function renderC(v, k, px, t) {
    const m = id('c');
    return svg(
      px,
      `<mask id="${m}"><rect width="32" height="32" fill="#fff"/><g fill="#000">${cEyes(v, px)}</g></mask>` +
        `<circle cx="16" cy="16" r="14.6" fill="${solid(t, k)}" mask="url(#${m})"/>`
    );
  }

  // =================================================================== D
  // Pebbles that look somewhere. One pebble generator (six seeds, same
  // area), white eyes with dark pupils; where it looks is the personality.
  function pebble(seed) {
    const p1 = seed * 1.7;
    const p2 = seed * 2.9 + 1;
    const pts = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r = 14.2 * (1 + 0.07 * Math.cos(2 * a + p1) + 0.035 * Math.cos(3 * a + p2));
      pts.push([16 + r * Math.cos(a), 16.2 + r * 0.97 * Math.sin(a)]);
    }
    return smoothClosed(pts);
  }
  const D_SHAPES = [0, 1, 2, 3, 4, 5].map(pebble);
  const D_GAZE = [
    [0, 0.3],
    [1.2, 0],
    [-1.2, 0],
    [0.9, -0.9],
    [0, 1.1],
    [-0.9, -0.9],
  ];
  const D_NAMES = ['Ahead', 'Right', 'Left', 'Up', 'Down', 'Wonder'];
  function renderD(v, k, px, t) {
    const [gx, gy] = D_GAZE[v % 6];
    const s = px <= 20 ? 1.18 : 1;
    const white = t === 'dark' ? 'oklch(0.97 0.005 90)' : '#fff';
    const pupil = deep(t, k);
    const eyeAt = (x) =>
      `<circle cx="${x}" cy="15" r="${r2(3.3 * s)}" fill="${white}"/>` +
      `<circle cx="${r2(x + gx * 0.75 * s)}" cy="${r2(15 + gy * 0.75 * s)}" r="${r2(2.15 * s)}" fill="${pupil}"/>`;
    return svg(px, `<path d="${D_SHAPES[v % 6]}" fill="${solid(t, k)}"/>${eyeAt(11.6)}${eyeAt(20.4)}`);
  }

  // =================================================================== E
  // Porthole: a neutral round window with a character rising into it.
  const E_BODIES = [
    { d: 'M6.5 34V19.5A9.5 9.5 0 0 1 25.5 19.5V34Z', ex: 16, ey: 18.5 },
    { d: 'M9 34V14A7 7 0 0 1 23 14V34Z', ex: 16, ey: 14.5 },
    { d: 'M3 34V19A6 6 0 0 1 9 13H23A6 6 0 0 1 29 19V34Z', ex: 16, ey: 18.5 },
    { d: 'M11 34V18A9 9 0 0 1 29 18V34Z', ex: 20, ey: 17.5 },
    { d: 'M5 34V18A8 8 0 0 1 13 10H19A8 8 0 0 1 27 18V34Z', ex: 16, ey: 16.5 },
  ];
  const E_NAMES = ['Dome', 'Tall', 'Wide', 'Peek', 'Square'];
  function renderE(v, k, px, t) {
    const b = E_BODIES[v % 5];
    const cl = id('e');
    const fg = deep(t, k);
    return svg(
      px,
      `<clipPath id="${cl}"><circle cx="16" cy="16" r="15"/></clipPath>` +
        `<circle cx="16" cy="16" r="15" fill="${CONTROL[t]}"/>` +
        `<g clip-path="url(#${cl})"><path d="${b.d}" fill="${solid(t, k)}"/>` +
        eye(b.ex - 3.3, b.ey, 1.45, 1.9, px, fg) +
        eye(b.ex + 3.3, b.ey, 1.45, 1.9, px, fg) +
        `</g>`
    );
  }

  // =================================================================== F
  // Orbs: a softly lit sphere and two dark eyes. No mouth.
  const F_EYES = [
    [11.8, 20.2, 15, 1.7, 2.4],
    [12, 20, 14.6, 1.45, 2.9],
    [10.8, 21.2, 15.6, 1.45, 1.9],
    [13.6, 21.6, 14.6, 1.7, 2.4],
    [12.9, 19.1, 13.2, 1.55, 2.1],
  ];
  const F_NAMES = ['Round', 'Tall', 'Wide-set', 'Glance', 'High'];
  function renderF(v, k, px, t) {
    const g = id('f');
    const [lx, rx, y, ex, ey] = F_EYES[v % 5];
    const L = t === 'dark' ? 0.74 : 0.7;
    const c = 0.13;
    return svg(
      px,
      `<defs><radialGradient id="${g}" cx="0.36" cy="0.3" r="0.78">` +
        `<stop offset="0" stop-color="${ok(L + 0.1, c * 0.75, k)}"/>` +
        `<stop offset="0.6" stop-color="${ok(L, c, k)}"/>` +
        `<stop offset="1" stop-color="${ok(L - 0.09, c, k)}"/></radialGradient></defs>` +
        `<circle cx="16" cy="16" r="14.6" fill="url(#${g})"/>` +
        eye(lx, y, ex, ey, px, deep(t, k), 2.4) +
        eye(rx, y, ex, ey, px, deep(t, k), 2.4)
    );
  }

  // =================================================================== G
  // Monogram with eyes: the agent's initial is its mouth line.
  function renderG(v, k, px, t, ctx) {
    const sel = ctx && ctx.selected;
    const fill = sel ? solid(t, k) : tone(t, k);
    const fg = sel ? SURFACE[t] : ink(t, k);
    const letter = ((ctx && ctx.name) || 'A').trim()[0].toUpperCase();
    // Below 28px two dots over a letter read as an accent (Ḧ), so the
    // sidebar shows the monogram alone and the eyes arrive from 28px.
    const small = px < 28;
    const eyes = small ? '' : eye(12.4, 10.4, 1.3, 1.65, px, fg, 1.6) + eye(19.6, 10.4, 1.3, 1.65, px, fg, 1.6);
    const size = small ? 15 : 14.5;
    const y = small ? 21.3 : 25.2;
    return svg(
      px,
      `<path d="${A_SHAPE}" fill="${fill}"/>${eyes}` +
        `<text x="16" y="${y}" text-anchor="middle" font-family="Geist, -apple-system, sans-serif" font-weight="640" font-size="${size}" fill="${fg}">${letter}</text>`
    );
  }

  // =================================================================== H
  // Profiles: every agent faces the conversation (right). One head, a
  // nose of three sizes and an eye; no mouth.
  const H_NAMES = ['Button', 'Snout', 'Beak-less', 'Long', 'Up'];
  const H_SPEC = [
    { nx: 25.6, ny: 18.6, nr: 4.2, ex: 20.2, ey: 13.6 },
    { nx: 25.2, ny: 19, nr: 5.4, ex: 19.4, ey: 13.2 },
    { nx: 0, ny: 0, nr: 0, ex: 21.4, ey: 14 },
    { nx: 26.4, ny: 19.6, nr: 4.6, ex: 19, ey: 13.4 },
    { nx: 25.6, ny: 15.6, nr: 4.4, ex: 18.8, ey: 12 },
  ];
  function renderH(v, k, px, t) {
    const s = H_SPEC[v % 5];
    const fill = solid(t, k);
    const head = `<circle cx="14.6" cy="16.4" r="13"/>`;
    const nose = s.nr ? `<circle cx="${s.nx}" cy="${s.ny}" r="${s.nr}"/><path d="M${s.nx} ${s.ny - s.nr}L18 ${s.ny - s.nr - 2}L18 ${s.ny + s.nr + 1}L${s.nx} ${s.ny + s.nr}Z"/>` : '';
    return svg(px, `<g fill="${fill}">${head}${nose}</g>${eye(s.ex, s.ey, 1.6, 2.1, px, deep(t, k), 2.4)}`);
  }

  // =================================================================== I / J
  // Embossed, even shapes: four silhouettes from one construction at one
  // area (so none reads bigger), each a soft pressed tile. The face is
  // chosen separately: dots, eyes + mouth, debossed, or none (a monogram).
  function pts2path(pts) {
    return pts.map((p, i) => `${i ? 'L' : 'M'}${r2(p[0])} ${r2(p[1])}`).join('') + 'Z';
  }
  function area(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a / 2);
  }
  function superPts(n, rot) {
    const out = [];
    for (let i = 0; i < 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const x = Math.sign(c) * Math.abs(c) ** (2 / n);
      const y = Math.sign(s) * Math.abs(s) ** (2 / n);
      out.push([x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)]);
    }
    return out;
  }
  function softHexPts(soften) {
    const v = Array.from({ length: 6 }, (_, i) => {
      const a = -Math.PI / 2 + (i * Math.PI) / 3;
      return [Math.cos(a), Math.sin(a)];
    });
    const out = [];
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    v.forEach((p, i) => {
      const a = lerp(p, v[(i + 5) % 6], soften);
      const b = lerp(p, v[(i + 1) % 6], soften);
      for (let j = 0; j <= 20; j++) {
        const t = j / 20;
        out.push([
          (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * p[0] + t * t * b[0],
          (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * p[1] + t * t * b[1],
        ]);
      }
    });
    return out;
  }
  // One target area: a 13.9-unit circle's. Each shape is scaled to it.
  const TARGET = Math.PI * 13.9 * 13.9;
  function even(pts) {
    const k = Math.sqrt(TARGET / area(pts));
    return pts.map(([x, y]) => [16 + x * k, 16 + y * k]);
  }
  const EVEN = [
    even(superPts(2, 0)),
    even(superPts(4.4, 0)),
    even(superPts(3, Math.PI / 4)),
    even(softHexPts(0.32)),
  ].map(pts2path);
  const EVEN_NAMES = ['Circle', 'Squircle', 'Diamond', 'Hexagon'];
  const FACE_TREATMENTS = ['Dot eyes', 'Eyes + mouth', 'Debossed', 'Monogram'];

  // A clay tone: a step brighter than the tonal fill so light and shade show.
  const clay = (t, k, dl = 0) => (t === 'dark' ? ok(0.53 + dl, 0.09, k) : ok(0.86 + dl, 0.07, k));
  const clayInk = (t, k) => (t === 'dark' ? ok(0.95, 0.04, k) : ok(0.36, 0.1, k));

  /** Light on the top rim, shade on the bottom rim, inside the shape only. */
  function embossFilter(fid, t, depth) {
    const hi = t === 'dark' ? 0.32 : 0.75;
    const lo = t === 'dark' ? 0.4 : 0.16;
    return (
      `<filter id="${fid}" x="-10%" y="-10%" width="120%" height="120%">` +
      `<feOffset in="SourceAlpha" dy="${depth}" result="dn"/>` +
      `<feComposite in="SourceAlpha" in2="dn" operator="out" result="top"/>` +
      `<feGaussianBlur in="top" stdDeviation="${r2(depth * 0.8)}" result="topb"/>` +
      `<feFlood flood-color="#fff" flood-opacity="${hi}"/><feComposite in2="topb" operator="in" result="hl"/>` +
      `<feOffset in="SourceAlpha" dy="${-depth}" result="up"/>` +
      `<feComposite in="SourceAlpha" in2="up" operator="out" result="bot"/>` +
      `<feGaussianBlur in="bot" stdDeviation="${r2(depth * 0.9)}" result="botb"/>` +
      `<feFlood flood-color="#000" flood-opacity="${lo}"/><feComposite in2="botb" operator="in" result="sh"/>` +
      `<feMerge result="all"><feMergeNode in="SourceGraphic"/><feMergeNode in="hl"/><feMergeNode in="sh"/></feMerge>` +
      `<feComposite in="all" in2="SourceAlpha" operator="in"/>` +
      `</filter>`
    );
  }

  /**
   * The face, in one of four treatments. A pressed feature is a well: a
   * light lip under it and a darker fill, rather than ink laid on top.
   */
  function evenFace(face, k, px, t, name, fg, pressed) {
    const w = weight(px);
    const ex = 12.3;
    const ex2 = 19.7;
    const ey = 14.6;
    if (face === 0) return eye(ex, ey + 0.6, 1.6, 2.1, px, fg) + eye(ex2, ey + 0.6, 1.6, 2.1, px, fg);
    if (face === 1)
      return (
        eye(ex, ey, 1.5, 2, px, fg) +
        eye(ex2, ey, 1.5, 2, px, fg) +
        (px <= 18 ? '' : line('M14 19.7Q16 21.2 18 19.7', w, fg))
      );
    const lip = t === 'dark' ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.95)';
    const well = t === 'dark' ? ok(0.27, 0.06, k) : ok(0.58, 0.09, k);
    const d = pressed ? 0.7 : 0;
    if (face === 2) {
      const one = (x, y, rx, ry) =>
        (d ? eye(x, y + d, rx, ry, px, lip) : '') + eye(x, y, rx, ry, px, pressed ? well : fg);
      return (
        one(ex, ey, 1.65, 2.15) +
        one(ex2, ey, 1.65, 2.15) +
        (px <= 18
          ? ''
          : (d ? line(`M13.8 ${19.7 + d}Q16 ${21.3 + d} 18.2 ${19.7 + d}`, w, lip) : '') +
            line('M13.8 19.7Q16 21.3 18.2 19.7', w, pressed ? well : fg))
      );
    }
    const letter = (name || 'A').trim()[0].toUpperCase();
    const txt = (fill, dy) =>
      `<text x="16" y="${r2(21.4 + dy)}" text-anchor="middle" font-family="Geist, -apple-system, sans-serif" font-weight="600" font-size="15" fill="${fill}">${letter}</text>`;
    return pressed ? txt(lip, 0.7) + txt(well, 0) : txt(fg, 0);
  }

  function renderEven(mode) {
    return function (v, k, px, t, ctx) {
      ctx = ctx || {};
      const shape = EVEN[v % 4];
      const face = ctx.face !== undefined ? ctx.face : mode === 'cap' ? 0 : 2;
      const lit = px >= 24;
      const sel = Boolean(ctx.selected);
      const base = sel ? solid(t, k) : clay(t, k);
      const fg = sel ? SURFACE[t] : clayInk(t, k);
      const pressed = lit && !sel && (face === 2 || face === 3);
      const g = id('g');
      const f = id('m');
      const grad =
        `<linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${sel ? solid(t, k) : clay(t, k, 0.035)}"/>` +
        `<stop offset="1" stop-color="${sel ? solid(t, k) : clay(t, k, -0.035)}"/></linearGradient>`;
      const faceSvg = evenFace(face, k, px, t, ctx.name, fg, pressed);
      if (!lit) return svg(px, `<path d="${shape}" fill="${base}"/>${faceSvg}`);
      if (mode === 'emboss') {
        const depth = px >= 40 ? 0.9 : 1.2;
        return svg(
          px,
          `<defs>${grad}${embossFilter(f, t, depth)}</defs><path d="${shape}" fill="url(#${g})" filter="url(#${f})"/>${faceSvg}`
        );
      }
      // Key cap: a side (the same shape, darker), a lit top set up off it,
      // and a soft shadow under the lot.
      const sh = id('s');
      const side = sel ? ok(t === 'dark' ? 0.6 : 0.56, 0.12, k) : clay(t, k, t === 'dark' ? -0.13 : -0.12);
      return svg(
        px,
        `<defs>${grad}${embossFilter(f, t, 0.7)}` +
          `<filter id="${sh}" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur stdDeviation="0.9"/></filter></defs>` +
          `<path d="${shape}" transform="translate(0 1.1)" fill="#000" opacity="${t === 'dark' ? 0.55 : 0.2}" filter="url(#${sh})"/>` +
          `<path d="${shape}" fill="${side}"/>` +
          `<g transform="translate(16 15.1) scale(0.9) translate(-16 -16)">` +
          `<path d="${shape}" fill="url(#${g})" filter="url(#${f})"/>${faceSvg}</g>`
      );
    };
  }

  window.AVATAR_DIRECTIONS = {
    hues: HUE_KEYS,
    solid,
    tone,
    list: [
      {
        key: 'A',
        name: 'Squircle',
        rule: 'One squircle. Identity is the hue (ten at equal OKLCH lightness) plus five faces.',
        variants: A_FACES,
        render: renderA,
      },
      {
        key: 'B',
        name: 'Siblings',
        rule: 'Five creatures from one grid: one body, one face at one height; only the top differs.',
        variants: B_NAMES,
        render: renderB,
      },
      {
        key: 'C',
        name: 'Knockout eyes',
        rule: 'A solid disc with the eyes cut out. Six eye shapes are the whole expression.',
        variants: C_NAMES,
        render: renderC,
      },
      {
        key: 'D',
        name: 'Pebbles',
        rule: 'Six pebbles from one generator, white eyes and dark pupils: where it looks is who it is.',
        variants: D_NAMES,
        render: renderD,
      },
      {
        key: 'E',
        name: 'Porthole',
        rule: 'A neutral round window, a character rising into it in its colour.',
        variants: E_NAMES,
        render: renderE,
      },
      {
        key: 'F',
        name: 'Orbs',
        rule: 'A softly lit sphere and two dark eyes; five eye settings, no mouth.',
        variants: F_NAMES,
        render: renderF,
      },
      {
        key: 'G',
        name: 'Monogram',
        rule: 'The initials badge, given eyes: the letter is the mouth. Below 28px it is the monogram alone.',
        variants: ['By name'],
        render: renderG,
      },
      {
        key: 'H',
        name: 'Profiles',
        rule: 'Every agent faces the conversation: one head, a nose, one eye.',
        variants: H_NAMES,
        render: renderH,
      },
      {
        key: 'I',
        name: 'Embossed',
        rule: 'Four even shapes (one construction, one area), pressed soft: light on the top rim, shade on the bottom. Flat below 24px.',
        variants: EVEN_NAMES,
        faces: FACE_TREATMENTS,
        defaultFace: 2,
        render: renderEven('emboss'),
      },
      {
        key: 'J',
        name: 'Key caps',
        rule: 'The same four even shapes, raised like a key: a darker side, a lit top, a soft shadow. Flat below 24px.',
        variants: EVEN_NAMES,
        faces: FACE_TREATMENTS,
        defaultFace: 0,
        render: renderEven('cap'),
      },
    ],
  };
})();
