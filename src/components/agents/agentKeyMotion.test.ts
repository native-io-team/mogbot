/**
 * The typing key's press is CSS keyframes on the desk (agents-work.css) and a
 * Reanimated worklet on the phone, both from the spec (`TYPING_KEY`). This
 * reads the stylesheet and the tokens as text and checks the keyframes, the
 * period and the box are the spec's.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TYPING_KEY } from '../../../packages/companion-protocol/src/avatar';

// Paths from the repo root, where Vitest runs.
const css = readFileSync('src/styles/features/agents-work.css', 'utf8');
const tokens = readFileSync('src/styles/global/tokens-components.css', 'utf8');

function block(from: string): string {
  const start = css.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('\n}\n', start));
}

function frames(): [number, number][] {
  return [
    ...block('@keyframes agents-key-press {').matchAll(
      /(\d+)%\s*\{\s*transform:\s*translateY\(([^;]*)\);/g
    ),
  ].map((m) => {
    const n = m[2].match(/^calc\((-?[\d.]+) \* var\(--agents-key-travel\)\)$/);
    return [Number(m[1]) / 100, n ? Number(n[1]) : Number(m[2])];
  });
}

/** A size token's px, from the comment the token carries. */
function px(token: string): number {
  const line = tokens.match(new RegExp(`${token}:[^;]*; /\\* (\\d+)px \\*/`));
  expect(line, token).not.toBeNull();
  return Number(line![1]);
}

describe('the typing key on the desk', () => {
  it('presses with the spec’s keyframes', () => {
    expect(frames()).toEqual(TYPING_KEY.press.map(([t, d]) => [t, d]));
  });

  it('is the spec’s size and period', () => {
    expect(px('--agents-key-width')).toBe(TYPING_KEY.width);
    expect(px('--agents-key-top')).toBe(TYPING_KEY.top);
    expect(px('--agents-key-travel')).toBe(TYPING_KEY.travel);
    expect(px('--agents-key-avatar')).toBe(TYPING_KEY.avatar);
    expect(tokens).toMatch(/--agents-key-radius: var\(--space-06\);/);
    expect(TYPING_KEY.radius).toBe(6);
    // Twice --duration-loader-standard (1200ms).
    expect(tokens).toMatch(/--agents-key-period: calc\(var\(--duration-loader-standard\) \* 2\);/);
    expect(TYPING_KEY.ms).toBe(2400);
  });

  it('moves only the top, by transform, and rests with Reduce Motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.agent-key\[data-pressing\] \.agent-key__top \{\s*animation: none;/);
    expect(block('@keyframes agents-key-press {')).not.toMatch(/box-shadow|height|top:|background/);
  });
});
