import { quotaLines, routineWeekLine, type QuotaLine } from '@shipstudio/companion-protocol';
import { render, screen } from '@testing-library/react-native';
import { QuotaLines } from '../src/components/QuotaLines';
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
    expect(lines[1].text).toMatch(/^Codex usage limit · resets /);
    // After every reset, nothing is left to say.
    expect(quotaLines(real.agentsQuota, 1_762_500_000_000)).toEqual([]);
    expect(routineWeekLine(real.agentsUsage.routines?.[0]?.week)).toBe('$0.30 this week');
  });

  it('shows nothing without a reading, and amber from 90%', async () => {
    await render(<QuotaLines lines={[]} />);
    expect(screen.toJSON()).toBeNull();
    const line: QuotaLine = {
      engine: 'claude',
      text: 'Claude usage 93% · resets Sat',
      tone: 'warning',
      detail: 'As Claude Code reported it at 9:00 AM, for its weekly limit.',
      percent: 93,
    };
    await render(<QuotaLines lines={[line]} />);
    const text = screen.getByText('Claude usage 93% · resets Sat');
    expect(text.props.accessibilityLabel).toMatch(/weekly limit/);
  });

  it('a weekly usage limit names its day, never just a clock time', () => {
    const inThreeDays = Date.now() + 72 * HOUR;
    const line = failureLine({ kind: 'usage_limit', resetsAt: inThreeDays }, null);
    expect(line).toMatch(/^Usage limit · resets /);
    expect(line).not.toMatch(/^Usage limit · resets \d/);
  });
});
