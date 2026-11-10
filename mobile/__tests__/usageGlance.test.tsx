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
import { GlanceCard, GlanceRow, KeyCard } from '../src/components/usageStack';
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
  StyleSheet.flatten(screen.getByText(text).props.style)?.color as string | undefined;

describe('usage at a glance, on the phone', () => {
  it('the Agents list line answers as the desk sidebar does, and opens Usage', async () => {
    const glance = usageGlance([mac, work], inventory([line('default', 30), line('w', 50)]), {
      now: NOW,
    });
    const onPress = jest.fn();
    await render(<GlanceRow glance={glance} onPress={onPress} />);
    expect(screen.getByText('Plenty of room')).toBeTruthy();
    expect(screen.getByText(/^2 accounts · resets /)).toBeTruthy();
    // Never the old "Claude usage 41% · resets Thu".
    expect(screen.queryByText(/usage \d+%/)).toBeNull();
    fireEvent.press(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalled();
  });

  it('names every account in full, never "This Mac", each with what it has left', async () => {
    const glance = usageGlance([mac, work], inventory([line('default', 30), line('w', 50)]), {
      now: NOW,
    });
    await render(<GlanceCard glance={glance} />);
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
    await render(<GlanceCard glance={glance} />);
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
    expect(amber).not.toContain(colorOf(/^At this pace it runs out /));
  });
});
