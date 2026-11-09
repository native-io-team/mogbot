import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDEPENDENCE,
  INDEPENDENCE_ALWAYS_ASKS,
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_ENDS,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_ROW_LABEL,
  INDEPENDENCE_SHORT,
  INDEPENDENCE_STILL_ASKS,
  INDEPENDENCE_TITLE,
  effectiveIndependence,
  independenceOf,
  independenceRowLabel,
  independenceStep,
  independenceValueText,
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

  it('four stops, strictest first, one line each, and one line true at every stop', () => {
    expect(INDEPENDENCE_LEVELS).toEqual(['often', 'judgement', 'go_hard', 'full_send']);
    expect(INDEPENDENCE_LEVELS.map((l) => INDEPENDENCE_LABEL[l])).toEqual([
      'Careful',
      'Steady',
      'Bold',
      'Unleashed',
    ]);
    expect(INDEPENDENCE_TITLE).toBe('How much it does on its own');
    expect(INDEPENDENCE_ENDS).toEqual({ low: 'Asks a lot', high: 'Just does it' });
    for (const level of INDEPENDENCE_LEVELS) {
      expect(INDEPENDENCE_DETAIL[level]).not.toContain('\n');
      expect(INDEPENDENCE_DETAIL[level].length).toBeLessThan(100);
      expect(INDEPENDENCE_STILL_ASKS[level]).toBe(INDEPENDENCE_ALWAYS_ASKS);
      expect(independenceValueText(level)).toBe(
        `${INDEPENDENCE_LABEL[level]}. ${INDEPENDENCE_DETAIL[level]}`
      );
    }
    expect(INDEPENDENCE_ALWAYS_ASKS).toBe(
      'Always asks before spending money, using your passwords, or deleting for good.'
    );
    // No old name is ever shown.
    const shown = JSON.stringify([INDEPENDENCE_LABEL, INDEPENDENCE_DETAIL, INDEPENDENCE_SHORT]);
    expect(shown).not.toMatch(/full send|go hard|good judgement|check with me/i);
    // Only Unleashed sends, posts or pushes on its own.
    expect(INDEPENDENCE_DETAIL.go_hard).toMatch(/asks before anything leaves it/);
    expect(INDEPENDENCE_DETAIL.full_send).toMatch(/Sends, posts and pushes/);
    expect(independenceOf('full_send')).toBe('full_send');
  });

  it('a slider: steps hold at the ends', () => {
    expect(independenceStep('judgement', 1)).toBe('go_hard');
    expect(independenceStep('judgement', -1)).toBe('often');
    expect(independenceStep('often', -1)).toBe('often');
    expect(independenceStep('full_send', 1)).toBe('full_send');
    expect(independenceStep('often', 9)).toBe('full_send');
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
    expect(independenceRowLabel(agent, team)).toBe('Unleashed');
    expect(real.agentsSetAgentIndependence.level).toBe('full_send');
    // Same as the team, or none of its own: no label.
    expect(independenceRowLabel({ independence: 'go_hard' }, 'go_hard')).toBeNull();
    expect(independenceRowLabel({}, 'go_hard')).toBeNull();
    expect(effectiveIndependence({}, 'go_hard')).toBe('go_hard');
    expect(effectiveIndependence({}, undefined)).toBe('judgement');
    expect(independenceRowLabel({ independence: 'often' }, 'go_hard')).toBe('Careful');
    expect(sameAsTeamLabel('go_hard')).toBe('Same as team (Bold)');
    expect(sameAsTeamLabel(undefined)).toBe('Same as team (Steady)');
    expect(ownIndependenceCount([{ independence: 'often' }, {}, { independence: 'go_hard' }])).toBe(2);
    expect(ownIndependenceLine(2)).toBe('Agents set on their own: 2');
    for (const level of INDEPENDENCE_LEVELS) {
      expect(INDEPENDENCE_SHORT[level].length).toBeLessThan(20);
      expect(INDEPENDENCE_ROW_LABEL[level].length).toBeLessThan(16);
    }
  });
});
