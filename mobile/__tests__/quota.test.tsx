import { quotaLines, routineWeekLine } from '@shipstudio/companion-protocol';
import { failureLine } from '../src/lib/agents';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';

const HOUR = 3_600_000;

describe('usage before the wall, on the phone', () => {
  it('reads what a Mac really serves for agents.quota and agents.usage', () => {
    // The Mac's own serde output (companion/fixtures.rs), at a time before its resets.
    const lines = quotaLines(real.agentsQuota, 1_762_290_000_000);
    expect(lines.map((l) => [l.engine, l.tone])).toEqual([
      ['claude', 'calm'],
      ['codex', 'limited'],
    ]);
    expect(lines[0].text).toMatch(/^Claude usage 85% · resets /);
    expect(lines[1].text).toMatch(/^Codex out of usage until /);
    // After every reset, nothing is left to say.
    expect(quotaLines(real.agentsQuota, 1_762_500_000_000)).toEqual([]);
    expect(routineWeekLine(real.agentsUsage.routines?.[0]?.week)).toBe(
      '$0.30 at API prices this week'
    );
    // With a Claude plan reading, never a dollar figure.
    expect(routineWeekLine(real.agentsUsage.routines?.[0]?.week, true)).toMatch(
      /^\d+(\.\d)?k? tokens this week$/
    );
  });

  it('a weekly usage limit names its day, never just a clock time', () => {
    const inThreeDays = Date.now() + 72 * HOUR;
    const line = failureLine({ kind: 'usage_limit', resetsAt: inThreeDays }, null);
    expect(line).toMatch(/^Out of usage until /);
    expect(line).not.toMatch(/^Out of usage until \d/);
  });
});
