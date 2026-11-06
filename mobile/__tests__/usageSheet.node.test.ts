/**
 * The usage ring and sheet (lib/usageSheet.ts): only figures the Mac served,
 * no row without a reading.
 */

import type { Quota, UsageInventory } from '@shipstudio/companion-protocol';
import {
  accountBlocks,
  contextMeter,
  planUsage,
  ringPercent,
  tokensShort,
  weeklyLabel,
} from '../src/lib/usageSheet';

const NOW = new Date(2026, 10, 5, 12, 0).getTime();
const HOUR = 3_600_000;

const claude: Quota = {
  engine: 'claude',
  windows: [
    {
      kind: 'seven_day',
      usedPercent: 41.7,
      resetsAt: NOW + 72 * HOUR,
      limited: false,
      observedAt: NOW,
    },
    {
      kind: 'five_hour',
      usedPercent: 38.9,
      resetsAt: NOW + 2 * HOUR,
      limited: false,
      observedAt: NOW,
    },
    {
      kind: 'seven_day_opus',
      usedPercent: 12,
      resetsAt: NOW + 72 * HOUR,
      limited: false,
      observedAt: NOW,
    },
  ],
};

describe('context', () => {
  it('says the share and the tokens, as the engine reported them', () => {
    expect(contextMeter({ used: 319_900, window: 1_000_000, at: NOW })).toMatchObject({
      label: '31% used',
      detail: '319.9K of 1M tokens',
      percent: 31,
    });
  });
  it('is absent when the engine said nothing', () => {
    expect(contextMeter(undefined)).toBeNull();
    expect(contextMeter({ used: 5, window: 0, at: NOW })).toBeNull();
  });
  it('shortens tokens', () => {
    expect(tokensShort(850)).toBe('850');
    expect(tokensShort(200_000)).toBe('200K');
    expect(tokensShort(1_500_000)).toBe('1.5M');
  });
});

describe('the plan', () => {
  it('splits the session from the weekly limits, All models first', () => {
    const plan = planUsage([claude], 'claude', NOW)!;
    expect(plan.session).toMatchObject({ label: '5-hour limit', percent: 38 });
    expect(plan.session!.detail).toMatch(/^Resets at /);
    expect(plan.weekly.map((m) => m.label)).toEqual(['All models', 'Opus']);
    expect(plan.weekly[0].detail).toMatch(/^Resets /);
  });

  it('draws the ring from the 5-hour window, and nothing without one', () => {
    expect(ringPercent([claude], 'claude', NOW)).toEqual({ percent: 38, tone: 'calm' });
    expect(ringPercent([claude], 'codex', NOW)).toBeNull();
    expect(ringPercent(null, 'claude', NOW)).toBeNull();
  });

  it('leaves out a window past its reset, and says used up as 100%', () => {
    const q: Quota = {
      engine: 'claude',
      windows: [
        { kind: 'five_hour', usedPercent: 50, resetsAt: NOW - 1, limited: false, observedAt: NOW },
        { kind: 'seven_day', limited: true, resetsAt: NOW + HOUR, observedAt: NOW },
      ],
    };
    const plan = planUsage([q], 'claude', NOW)!;
    expect(plan.session).toBeNull();
    expect(plan.weekly[0]).toMatchObject({ percent: 100, tone: 'limited' });
  });

  it('names windows it knows, and an unknown one by its own word', () => {
    expect(weeklyLabel({ kind: 'seven_day_sonnet' })).toBe('Sonnet');
    expect(weeklyLabel({ kind: 'monthly_thing' })).toBe('Monthly thing');
  });
});

describe('every account', () => {
  it('gives each account its limits, or its state when there is nothing to draw', () => {
    const inv = {
      accounts: [
        {
          engine: 'codex',
          id: 'c1',
          name: 'Personal',
          thisMac: true,
          signedIn: true,
          out: false,
          next: true,
          plan: 'plus',
          windows: [],
          learned: [],
        },
        {
          engine: 'claude',
          id: 'a1',
          name: 'Work',
          thisMac: true,
          signedIn: true,
          out: false,
          next: true,
          windows: claude.windows,
          learned: [],
        },
      ],
    } as unknown as UsageInventory;
    const blocks = accountBlocks(inv, NOW);
    expect(blocks.map((b) => b.title)).toEqual(['Claude · Work', 'Codex · Personal']);
    expect(blocks[0].meters.map((m) => m.label)).toEqual(['All models', '5-hour limit', 'Opus']);
    expect(blocks[0].state).toBeNull();
    expect(blocks[1].meters).toEqual([]);
    expect(blocks[1].state).toBe('No reading yet');
    expect(blocks[1].tags).toEqual(['Plus plan', 'Next turns run here']);
  });

  it('is empty on a Mac that serves no inventory', () => {
    expect(accountBlocks(null, NOW)).toEqual([]);
  });
});
