import { describe, expect, it } from 'vitest';
import type { Quota, UsageAccountLine, UsageInventory, UsagePace } from './model';
import { accountBlocks, paceLine, planUsage, roughWhen } from './usageSheet';
import * as real from './fixtures.gen';

// A Thursday, noon local.
const NOW = new Date(2026, 10, 5, 12, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

const pace = (over: Partial<UsagePace> = {}): UsagePace => ({
  estimate: true,
  kind: 'five_hour',
  resetsAt: NOW + 4 * HOUR,
  reachesAt: NOW + 2 * HOUR,
  readings: 6,
  spanMinutes: 95,
  ...over,
});

const quotas: Quota[] = [
  {
    engine: 'claude',
    windows: [
      {
        kind: 'five_hour',
        usedPercent: 62,
        resetsAt: NOW + 4 * HOUR,
        limited: false,
        observedAt: NOW,
      },
      {
        kind: 'seven_day',
        usedPercent: 30,
        resetsAt: NOW + 80 * HOUR,
        limited: false,
        observedAt: NOW,
      },
    ],
  },
];

const account = (over: Partial<UsageAccountLine> = {}): UsageAccountLine => ({
  engine: 'claude',
  id: 'default',
  name: 'This Mac',
  thisMac: true,
  signedIn: true,
  out: false,
  next: true,
  windows: quotas[0].windows,
  learned: [],
  ...over,
});

const inventory = (accounts: UsageAccountLine[]): UsageInventory => ({
  ...real.agentsUsagePlan,
  accounts,
  now: NOW,
});

describe('the pace line', () => {
  it('says when, roughly, and what it rests on', () => {
    const line = paceLine(pace(), NOW)!;
    expect(line.text).toBe(
      `At this pace you’ll hit the limit in about 2 hours, before it resets ${'at'} ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(NOW + 4 * HOUR)}`
    );
    expect(line.basis).toBe('Estimate from 6 readings over 2 hours');
  });

  it('is absent without an estimate, or once it no longer says anything', () => {
    expect(paceLine(undefined, NOW)).toBeNull();
    // Not marked an estimate: never shown as one.
    expect(paceLine({ ...pace(), estimate: false } as unknown as UsagePace, NOW)).toBeNull();
    // The crossing passed, or lands after the reset.
    expect(paceLine(pace({ reachesAt: NOW - MIN }), NOW)).toBeNull();
    expect(paceLine(pace({ reachesAt: NOW + 5 * HOUR }), NOW)).toBeNull();
  });

  it('names a part of a day, never a minute it cannot know', () => {
    expect(roughWhen(NOW + 40 * MIN, NOW)).toBe('in about 40 minutes');
    expect(roughWhen(NOW + 58 * MIN, NOW)).toBe('in about an hour');
    expect(roughWhen(NOW + 4 * HOUR, NOW)).toBe('this afternoon');
    expect(roughWhen(new Date(2026, 10, 5, 22, 0).getTime(), NOW)).toBe('tonight');
    expect(roughWhen(new Date(2026, 10, 6, 9, 0).getTime(), NOW)).toBe('tomorrow morning');
    expect(roughWhen(new Date(2026, 10, 7, 2, 0).getTime(), NOW)).toMatch(/^early \w+ morning$/);
    expect(roughWhen(new Date(2026, 10, 9, 15, 0).getTime(), NOW)).toMatch(/^\w+ afternoon$/);
  });

  it('rides on the matching window in the plan and the account', () => {
    const inv = inventory([account({ pace: [pace()] })]);
    const plan = planUsage(quotas, 'claude', NOW, inv)!;
    expect(plan.session?.pace?.basis).toBe('Estimate from 6 readings over 2 hours');
    expect(plan.weekly[0].pace).toBeUndefined();
    // Without the inventory, or from another engine's account: no pace.
    expect(planUsage(quotas, 'claude', NOW)!.session?.pace).toBeUndefined();
    const codexOnly = inventory([account({ engine: 'codex', pace: [pace()] })]);
    expect(planUsage(quotas, 'claude', NOW, codexOnly)!.session?.pace).toBeUndefined();
    // Another instance of the window (a different reset): not this one's.
    const stale = inventory([account({ pace: [pace({ resetsAt: NOW - HOUR })] })]);
    expect(planUsage(quotas, 'claude', NOW, stale)!.session?.pace).toBeUndefined();
    const blocks = accountBlocks(inv, NOW);
    expect(blocks[0].meters[0].pace?.text).toMatch(/^At this pace/);
    expect(blocks[0].meters[1].pace).toBeUndefined();
  });

  it('the served fixture carries one, labelled an estimate', () => {
    const served = real.agentsUsagePlan.accounts.flatMap((a) => a.pace ?? []);
    expect(served.length).toBeGreaterThan(0);
    expect(served.every((p) => p.estimate === true)).toBe(true);
  });
});
