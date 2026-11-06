import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDEPENDENCE,
  INDEPENDENCE_ALWAYS_ASKS,
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_ROW_LABEL,
  INDEPENDENCE_SHORT,
  INDEPENDENCE_STILL_ASKS,
  effectiveIndependence,
  independenceOf,
  independenceRowLabel,
  ownIndependenceCount,
  ownIndependenceLine,
  sameAsTeamLabel,
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
    expect((READ_ONLY_METHODS as readonly string[]).includes('agents.setAgentIndependence')).toBe(
      false
    );
  });

  it('one agent may have its own level: the overview says so, and the row only when it differs', () => {
    const [agent] = real.agentsOverview.agents;
    const team = real.agentsOverview.independence;
    expect(agent.independence).toBe('full_send');
    expect(effectiveIndependence(agent, team)).toBe('full_send');
    expect(independenceRowLabel(agent, team)).toBe('Full send');
    expect(real.agentsSetAgentIndependence.level).toBe('full_send');
    // Same as the team, or none of its own: no label.
    expect(independenceRowLabel({ independence: 'go_hard' }, 'go_hard')).toBeNull();
    expect(independenceRowLabel({}, 'go_hard')).toBeNull();
    expect(effectiveIndependence({}, 'go_hard')).toBe('go_hard');
    expect(effectiveIndependence({}, undefined)).toBe('judgement');
    expect(independenceRowLabel({ independence: 'often' }, 'go_hard')).toBe('Checks often');
    expect(sameAsTeamLabel('go_hard')).toBe('Same as team (Go hard)');
    expect(sameAsTeamLabel(undefined)).toBe('Same as team (Use good judgement)');
    expect(ownIndependenceCount([{ independence: 'often' }, {}, { independence: 'go_hard' }])).toBe(2);
    expect(ownIndependenceLine(2)).toBe('Agents set on their own: 2');
    for (const level of INDEPENDENCE_LEVELS) {
      expect(INDEPENDENCE_SHORT[level].length).toBeLessThan(20);
      expect(INDEPENDENCE_ROW_LABEL[level].length).toBeLessThan(16);
    }
  });
});
