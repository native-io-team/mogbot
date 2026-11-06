/**
 * The desk's avatar motion is CSS keyframes (agents-avatar.css), the phone's
 * Reanimated sequences built from the spec (`AVATAR_MOTION` in avatar.ts).
 * This reads the stylesheet as text (Vitest stubs CSS imports) and checks
 * that each mood's keyframes and duration are the spec's, value for value.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AVATAR_MOTION, type AvatarMood } from '../../../packages/companion-protocol/src/avatar';

// Paths from the repo root, where Vitest runs.
const css = readFileSync('src/styles/features/agents-avatar.css', 'utf8');
const core = readFileSync('src/styles/global/tokens-core.css', 'utf8');

/** `@keyframes name { 12% { … } … }` as [percent, declarations] pairs. */
function keyframes(name: string): [number, string][] {
  const start = css.indexOf(`@keyframes ${name} {`);
  expect(start, name).toBeGreaterThan(-1);
  const out: [number, string][] = [];
  let i = css.indexOf('{', start) + 1;
  let depth = 1;
  let block = '';
  for (; i < css.length && depth > 0; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    block += ch;
  }
  for (const m of block.matchAll(/(\d+)%\s*\{([^}]*)\}/g)) out.push([Number(m[1]) / 100, m[2]]);
  return out;
}

/** The multiples of a unit in `translate(a, b)`: `calc(0.5 * var(--agent-avatar-fu))` → 0.5, `0` → 0. */
function translate(decl: string): [number, number] {
  const m = decl.match(/translate\((.*)\);/s);
  expect(m, decl).not.toBeNull();
  // Split on the comma between the two arguments, not those inside calc().
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < m![1].length; i++) {
    const ch = m![1][i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) cut = i;
  }
  const value = (s: string) => {
    const n = s.trim().match(/^calc\((-?[\d.]+) \* var\(--agent-avatar-[fp]u\)\)$/);
    return n ? Number(n[1]) : Number(s.trim());
  };
  return [value(m![1].slice(0, cut)), value(m![1].slice(cut + 1))];
}

/** A duration token on :root, evaluated against the core tokens. */
function duration(token: string): number {
  const line = css.match(new RegExp(`${token}:\\s*([^;]+);`))![1];
  // `calc(var(--x) * a / b)`: the token's ms, then each `*` or `/` left to right.
  const tokens = line
    .replace(/^calc\(|\)\s*$/g, '')
    .replace(
      /var\((--[\w-]+)\)/g,
      (_, v: string) => core.match(new RegExp(`${v}:\\s*(\\d+)ms`))![1]
    )
    .split(/\s+/);
  let value = Number(tokens[0]);
  for (let i = 1; i < tokens.length; i += 2) {
    const n = Number(tokens[i + 1]);
    value = tokens[i] === '*' ? value * n : value / n;
  }
  return value;
}

const NAMES: Record<AvatarMood, { face?: string; press?: string; glow?: string; ms: string }> = {
  idle: { face: 'agents-avatar-idle', ms: '--agents-avatar-idle' },
  working: { face: 'agents-avatar-look', glow: 'agents-avatar-glow', ms: '--agents-avatar-look' },
  needs: {
    face: 'agents-avatar-attend',
    press: 'agents-avatar-press-once',
    ms: '--agents-avatar-needs',
  },
  done: { press: 'agents-avatar-press-bounce', ms: '--agents-avatar-done' },
  failed: { face: 'agents-avatar-fail', ms: '--agents-avatar-failed' },
};

describe('the desk’s avatar motion is the spec’s', () => {
  for (const mood of Object.keys(NAMES) as AvatarMood[]) {
    it(mood, () => {
      const spec = AVATAR_MOTION[mood];
      const names = NAMES[mood];
      expect(duration(names.ms)).toBeCloseTo(spec.ms, 6);
      if (names.face) {
        const frames = keyframes(names.face).map(
          ([t, d]) => [t, ...translate(d)] as [number, number, number]
        );
        expect(frames).toEqual(spec.face!.map((k) => [...k]));
      } else expect(spec.face).toBeUndefined();
      if (names.press) {
        const frames = keyframes(names.press).map(([t, d]) => [t, translate(d)[1]]);
        expect(frames).toEqual(spec.press!.map((k) => [...k]));
      } else expect(spec.press).toBeUndefined();
      if (names.glow) {
        const frames = keyframes(names.glow).map(([t, d]) => [
          t,
          Number(d.match(/opacity:\s*([\d.]+)/)![1]),
        ]);
        expect(frames).toEqual(spec.glow!.map((k) => [...k]));
      } else expect(spec.glow).toBeUndefined();
    });
  }

  it('is still with Reduce Motion, and never rings or blinks', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.agent-avatar \*/);
    // Only transforms and the breathing light's opacity move: no ring, no
    // border, no squash of an eye.
    for (const m of css.matchAll(/@keyframes (agents-avatar-[\w-]+)/g)) {
      for (const [, decl] of keyframes(m[1])) {
        for (const prop of decl.matchAll(/([\w-]+)\s*:/g)) {
          expect(['transform', 'opacity'], m[1]).toContain(prop[1]);
        }
        expect(decl).not.toMatch(/scale/);
      }
    }
  });
});
