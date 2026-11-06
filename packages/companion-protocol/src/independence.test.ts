import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDEPENDENCE,
  INDEPENDENCE_ALWAYS_ASKS,
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_STILL_ASKS,
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

  it('four levels, strictest first, one line each, and honest about what still asks', () => {
    expect(INDEPENDENCE_LEVELS).toEqual(['often', 'judgement', 'go_hard', 'full_send']);
    for (const level of INDEPENDENCE_LEVELS) {
      expect(INDEPENDENCE_LABEL[level]).toBeTruthy();
      expect(INDEPENDENCE_DETAIL[level]).not.toContain('\n');
      expect(INDEPENDENCE_DETAIL[level].length).toBeLessThan(80);
    }
    expect(INDEPENDENCE_ALWAYS_ASKS).toMatch(/spends money, sends as you, or deletes/);
    for (const level of ['often', 'judgement', 'go_hard'] as const) {
      expect(INDEPENDENCE_STILL_ASKS[level]).toBe(INDEPENDENCE_ALWAYS_ASKS);
    }
    // Full send sends as you, so it never claims it asks first; the floor does.
    const full = INDEPENDENCE_STILL_ASKS.full_send;
    expect(full).not.toMatch(/sends as you/);
    for (const asks of ['spending money', 'passwords or keys', 'deleting', 'main or production', 'your Mac starts']) {
      expect(full).toContain(asks);
    }
    expect(independenceOf('full_send')).toBe('full_send');
  });

  it('setting it is a write: audited', () => {
    expect((READ_ONLY_METHODS as readonly string[]).includes('agents.setIndependence')).toBe(false);
  });
});
