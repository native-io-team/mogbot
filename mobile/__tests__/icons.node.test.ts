/**
 * Every SF Symbol the source names has a Material Symbol for Android
 * (`lib/icons.ts`): an unmapped one draws nothing there, silently. Start
 * fresh and Open Tailscale once lost their icons that way.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MATERIAL } from '../src/lib/icons';
import { STEP_SYMBOL } from '../src/lib/work';

const SRC = join(__dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const QUOTED = /'([a-z][a-z0-9]*(?:\.[a-z0-9]+)*)'|"([a-z][a-z0-9]*(?:\.[a-z0-9]+)*)"/g;

/** The quoted names in an expression, less the ones it compares against (`=== 'reply'`). */
function namesIn(expr: string): string[] {
  const out: string[] = [];
  for (const m of expr.matchAll(QUOTED)) {
    const before = expr.slice(0, m.index).trimEnd();
    if (/[=!]==?$/.test(before)) continue;
    out.push(m[1] ?? m[2]);
  }
  return out;
}

/**
 * Where a symbol is named: `<Icon name=…>` and `<IconButton name=…>` (other
 * elements' `name` is a route), any `icon=` prop, and an action's `icon: '…'`.
 */
function symbolsIn(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/<(?:Icon|IconButton)\b([^>]*?)\bname=(\{[^}]*\}|"[^"]*")/gs))
    found.push(...namesIn(m[2]));
  for (const m of source.matchAll(/\bicon=(\{[^}]*\}|"[^"]*")/g)) found.push(...namesIn(m[1]));
  for (const m of source.matchAll(/\bicon:\s*('[^']*'|"[^"]*")/g)) found.push(...namesIn(m[1]));
  return found;
}

describe('icons', () => {
  it('finds the symbols it checks (the scan itself works)', () => {
    expect(symbolsIn(`<Icon name="network" />`)).toEqual(['network']);
    expect(
      symbolsIn(`<Icon\n  name={mark.event === 'reply' ? 'terminal' : 'photo'}\n  size={1} />`)
    ).toEqual(['terminal', 'photo']);
    expect(symbolsIn(`{ id: 'pin', title: 'Pin', icon: 'pin' }`)).toEqual(['pin']);
    expect(symbolsIn(`<Stack.Screen name="viewer" />`)).toEqual([]);
  });

  it('maps every symbol named in the source to a Material Symbol', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const path of files(SRC)) {
      for (const name of symbolsIn(readFileSync(path, 'utf8'))) {
        seen++;
        if (!(name in MATERIAL)) missing.push(`${relative(SRC, path)}: ${name}`);
      }
    }
    expect(seen).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });

  it('maps every step glyph of the “what it did” timeline', () => {
    expect(Object.values(STEP_SYMBOL).filter((name) => !(name in MATERIAL))).toEqual([]);
  });
});
