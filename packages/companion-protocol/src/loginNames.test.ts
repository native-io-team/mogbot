import { describe, expect, it } from 'vitest';
import cases from './login-names.json';
import { humanise, KNOWN_NAMES } from './loginNames';

describe('humanise (as the Mac says it: login-names.json)', () => {
  it.each(cases.cases.map((c) => [c.key, c.title]))('%j reads as %j', (key, title) => {
    expect(humanise(key)).toBe(title);
  });

  it('has a shared case for every known name, so the Mac is held to it too', () => {
    const covered = new Set(cases.cases.flatMap((c) => c.key.toLowerCase().split(/[\s_.-]+/)));
    for (const name of Object.keys(KNOWN_NAMES)) expect(covered).toContain(name);
  });

  it('never shows a raw key', () => {
    for (const c of cases.cases) expect(humanise(c.key)).not.toMatch(/[_.]/);
  });
});
