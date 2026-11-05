import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDEPENDENCE,
  INDEPENDENCE_ALWAYS_ASKS,
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  independenceOf,
} from './independence';
import { READ_ONLY_METHODS } from './methods';
import * as real from './fixtures.gen';

describe('independence', () => {
  it('reads what a Mac really serves, and the default from one that sends none', () => {
    expect(independenceOf(real.agentsOverview.independence)).toBe('go_hard');
    expect(real.agentsSetIndependence.level).toBe('go_hard');
    expect(independenceOf(undefined)).toBe('judgement');
    expect(independenceOf('reckless' as never)).toBe(DEFAULT_INDEPENDENCE);
  });

  it('three levels, strictest first, one line each, and honest about what always asks', () => {
    expect(INDEPENDENCE_LEVELS).toEqual(['often', 'judgement', 'go_hard']);
    for (const level of INDEPENDENCE_LEVELS) {
      expect(INDEPENDENCE_LABEL[level]).toBeTruthy();
      expect(INDEPENDENCE_DETAIL[level]).not.toContain('\n');
      expect(INDEPENDENCE_DETAIL[level].length).toBeLessThan(80);
    }
    expect(INDEPENDENCE_ALWAYS_ASKS).toMatch(/spends money, sends as you, or deletes/);
  });

  it('setting it is a write: audited', () => {
    expect((READ_ONLY_METHODS as readonly string[]).includes('agents.setIndependence')).toBe(false);
  });
});
