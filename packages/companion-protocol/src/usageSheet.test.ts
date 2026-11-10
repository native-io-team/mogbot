import { describe, expect, it } from 'vitest';
import type { Quota, UsageAccountLine, UsageInventory, UsagePace } from './model';
import { accountBlocks, paceLine, planUsage, roughWhen, usageSheet } from './usageSheet';
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

describe('the Usage sheet shows each reading once', () => {
  const work = account({
    id: 'work',
    name: 'Work',
    thisMac: false,
    next: false,
    windows: [],
    out: true,
    outUntil: NOW + 3 * HOUR,
  });
  const codex = account({ engine: 'codex', id: 'c1', name: 'Personal', windows: [] });

  it('puts the account turns run on at the top, and never lists it again', () => {
    const inv = inventory([account({ pace: [pace()] }), work, codex]);
    const sheet = usageSheet(quotas, 'claude', inv, NOW);
    expect(sheet.active?.account).toBe('Claude Code account · Next turns run here');
    expect(sheet.active?.meters.map((m) => m.label)).toEqual([
      '5-hour limit',
      'Weekly · All models',
    ]);
    expect(sheet.active?.meters[0].pace?.text).toMatch(/^At this pace/);
    expect(sheet.others.map((b) => b.title)).toEqual(['Claude · Work', 'Codex · Personal']);
    // Each window, and the pace line, appears exactly once in the whole sheet.
    const all = [...sheet.active!.meters, ...sheet.others.flatMap((b) => b.meters)];
    expect(all.filter((m) => m.label === '5-hour limit')).toHaveLength(1);
    expect(all.filter((m) => m.pace)).toHaveLength(1);
  });

  it('follows the account next turns run on, not this Mac’s sign-in', () => {
    const inv = inventory([
      account({ next: false }),
      account({ id: 'work', name: 'Work', thisMac: false, next: true, windows: [] }),
    ]);
    const sheet = usageSheet(quotas, 'claude', inv, NOW);
    expect(sheet.active?.account).toBe('Work · Next turns run here');
    expect(sheet.active?.meters).toEqual([]);
    expect(sheet.active?.state).toBe('No reading yet');
    expect(sheet.others.map((b) => b.title)).toEqual(['Claude Code account']);
  });

  it('draws the plan’s own windows only when no account has the reading, unnamed', () => {
    const sheet = usageSheet(quotas, 'claude', null, NOW);
    expect(sheet.active?.account).toBeNull();
    expect(sheet.active?.meters.map((m) => m.label)).toEqual([
      '5-hour limit',
      'Weekly · All models',
    ]);
    expect(sheet.others).toEqual([]);
    // Readings not attributed to an account: the plan on top, the accounts as they are.
    const unattributed = inventory([account({ windows: [] }), codex]);
    const top = usageSheet(quotas, 'claude', unattributed, NOW);
    expect(top.active?.account).toBeNull();
    expect(top.others.map((b) => b.title)).toEqual(['Claude Code account', 'Codex · Personal']);
  });

  it('is empty with nothing reported', () => {
    expect(usageSheet(null, 'claude', null, NOW)).toEqual({ active: null, others: [] });
  });
});
