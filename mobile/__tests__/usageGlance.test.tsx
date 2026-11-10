/**
 * Usage at a glance on the phone, worded as the desk words it
 * (`usageGlance`): the Agents list's line, the Settings sheet with each
 * account named in full, and an estimate that never takes the colour that
 * means "needs you".
 */

import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  usageGlance,
  type UsageAccount,
  type UsageAccountLine,
  type UsageInventory,
} from '@shipstudio/companion-protocol';
import { AccountRows, GlanceRow, KeyCard, TotalCard } from '../src/components/usageStack';
import { palettes } from '../src/lib/theme';

const NOW = new Date(2026, 10, 9, 12, 0).getTime();
const H = 3_600_000;

const mac: UsageAccount = {
  id: 'default',
  engine: 'claude',
  name: 'Signed in on this Mac',
  named: false,
  thisMac: true,
  signedIn: true,
  out: false,
};
const work: UsageAccount = {
  id: 'w',
  engine: 'claude',
  name: 'Work',
  named: true,
  email: 'sam@northwind.example',
  thisMac: false,
  signedIn: true,
  out: false,
};

const line = (
  id: string,
  used: number,
  over: Partial<UsageAccountLine> = {}
): UsageAccountLine => ({
  engine: 'claude',
  id,
  name: id === 'default' ? 'This Mac' : 'Work',
  thisMac: id === 'default',
  signedIn: true,
  out: false,
  next: id === 'default',
  windows: [
    {
      kind: 'seven_day',
      usedPercent: used,
      resetsAt: NOW + 5 * 24 * H,
      limited: false,
      observedAt: NOW - 60_000,
    },
  ],
  learned: [],
  ...over,
});

const inventory = (lines: UsageAccountLine[], runOut = false): UsageInventory => ({
  mode: 'normal',
  engines: [],
  accounts: lines,
  local: [],
  spare: [],
  backlog: [],
  agents: [],
  routines: [],
  now: NOW,
  ...(runOut
    ? {
        totals: {
          accounts: lines.length,
          engines: [],
          read: lines.length,
          room: lines.length,
          windows: [],
          runOut: [
            { estimate: true, engine: 'claude', reachesAt: NOW + 24 * H, readings: 9, accounts: 2 },
          ],
        },
      }
    : {}),
});

const colorOf = (text: string | RegExp) =>
  (
    StyleSheet.flatten((screen.getByText(text).props as { style?: object }).style) as
      | { color?: string }
      | undefined
  )?.color;

describe('usage at a glance, on the phone', () => {
  it('the Agents list line answers as the desk sidebar does, and opens Usage', async () => {
    const glance = usageGlance([mac, work], inventory([line('default', 30), line('w', 50)]), {
      now: NOW,
    });
    const onPress = jest.fn();
    await render(<GlanceRow glance={glance} onPress={onPress} />);
    // The total across both accounts, then when it next refills.
    expect(screen.getByText(/60% left · 2 accounts/)).toBeTruthy();
    expect(screen.getByText(/^Refills in /)).toBeTruthy();
    expect(screen.queryByText('Plenty of room')).toBeNull();
    await fireEvent.press(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalled();
  });

  it('an account signed in twice draws no segment and says so in one line', async () => {
    const glance = usageGlance(
      [mac, work],
      inventory([line('default', 30), line('w', 30, { sameAs: 'This Mac' })]),
      { now: NOW }
    );
    expect(glance.meterKeys).toHaveLength(1);
    await render(<GlanceRow glance={glance} onPress={() => {}} />);
    // One real account: no "1 account" beside a meter that shows two.
    expect(screen.queryByText(/accounts?$/)).toBeNull();
    await render(<TotalCard glance={glance} />);
    expect(
      screen.getByText(
        'Work is the same Claude account as Claude Code account — adds no extra room'
      )
    ).toBeTruthy();
  });

  it('leads with the total, roomiest account first, each named in full, never "This Mac"', async () => {
    const glance = usageGlance([mac, work], inventory([line('default', 30), line('w', 50)]), {
      now: NOW,
    });
    const onOpen = jest.fn();
    await render(<TotalCard glance={glance} onOpen={onOpen} />);
    expect(screen.getByText('60% left')).toBeTruthy();
    expect(screen.getByText('across 2 accounts')).toBeTruthy();
    // Most room first: the account in use (70%) before Work (50%).
    const names = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel);
    expect(names[0]).toMatch(/^Claude Code account: 70% left/);
    expect(names[1]).toMatch(/^Work: 50% left/);
    await fireEvent.press(screen.getAllByRole('button')[1]);
    expect(onOpen).toHaveBeenCalledWith('claude', 'w');
    expect(screen.queryByText(/This Mac|Signed in on t/)).toBeNull();
    expect(screen.getByText('Claude Code account')).toBeTruthy();
    expect(screen.getByText('Work')).toBeTruthy();
    expect(screen.getByText('70% left')).toBeTruthy();
    expect(screen.getByText('50% left')).toBeTruthy();
  });

  it('an estimate is never amber: the run-out headline and a pace line are ink', async () => {
    const glance = usageGlance([mac, work], inventory([line('default', 40), line('w', 50)], true), {
      now: NOW,
    });
    expect(glance.estimate).not.toBeNull();
    await render(<TotalCard glance={glance} />);
    const amber = [palettes.light.accentWarning, palettes.dark.accentWarning];
    expect(amber).not.toContain(colorOf(/^Runs out /));

    const paced = usageGlance(
      [mac],
      inventory([
        line('default', 40, {
          pace: [
            {
              estimate: true,
              kind: 'seven_day',
              resetsAt: NOW + 5 * 24 * H,
              reachesAt: NOW + 24 * H,
              readings: 6,
              spanMinutes: 180,
            },
          ],
        }),
      ]),
      { now: NOW }
    );
    await render(<KeyCard k={paced.keys[0]} />);
    expect(amber).not.toContain(colorOf(/^Ahead of pace — at this rate it runs out /));
    expect(amber).not.toContain(colorOf(/^Estimate from /));
  });

  it('lists each account as a row in order that opens it, and its agents as a table', async () => {
    const spent = [{ agentId: 'c', name: 'Chief', turns: 9, tokens: 750_000 }];
    const glance = usageGlance(
      [mac, work],
      inventory([line('default', 30, { spent }), line('w', 50)]),
      { now: NOW }
    );
    const onOpen = jest.fn();
    await render(<AccountRows keys={glance.keys} onOpen={onOpen} />);
    const rows = screen.getAllByRole('button');
    expect(rows[0].props.accessibilityLabel).toMatch(/^1\. Claude Code account, 70% left, In use/);
    await fireEvent.press(rows[1]);
    expect(onOpen.mock.calls[0][0].id).toBe('w');
    await render(<KeyCard k={glance.keys[0]} />);
    expect(screen.getByText('Messages')).toBeTruthy();
    expect(screen.getByText('750k')).toBeTruthy();
  });
});
