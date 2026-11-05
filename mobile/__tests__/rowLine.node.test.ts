/**
 * A list row shortens the Mac's "waiting for a slot" sentence by matching its
 * English. Pinned here to the Mac's own source, so a reworded sentence fails
 * this test instead of silently showing the long form; anything else passes
 * through unchanged.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rowLine } from '../src/lib/agents';

const runner = readFileSync(join(__dirname, '../../src-tauri/src/agents/runner.rs'), 'utf8');

describe('rowLine', () => {
  it('matches the sentences the Mac writes', () => {
    expect(runner).toContain('"Waiting for a free slot ({busy} agents already working)"');
    expect(runner).toContain('"Waiting for free memory ({working} {} already working)"');
    expect(rowLine('Waiting for a free slot (4 agents already working)')).toBe(
      'Waiting for a free slot · 4 busy'
    );
    expect(rowLine('Waiting for free memory (1 agent already working)')).toBe(
      'Waiting for free memory · 1 busy'
    );
  });

  it('leaves any other wording exactly as the Mac sent it', () => {
    for (const line of [
      'Waiting for a free slot',
      'Waiting (4 agents busy)',
      'Running tests (2 agents already working) now',
      '',
    ])
      expect(rowLine(line)).toBe(line);
  });
});
