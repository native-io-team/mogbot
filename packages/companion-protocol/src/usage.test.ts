import { describe, expect, it } from 'vitest';
import {
  accountTags,
  accountUsage,
  estimateLine,
  localLine,
  spareLine,
  usageRows,
  windowLine,
} from './usage';
import type { UsageAccountLine, UsageInventory } from './model';
import * as real from './fixtures.gen';

// A Thursday, 2 PM local.
const NOW = new Date(2026, 10, 5, 14, 0).getTime();
const HOUR = 3_600_000;

const account = (over: Partial<UsageAccountLine> = {}): UsageAccountLine => ({
  engine: 'claude',
  id: 'default',
  name: 'This Mac',
  thisMac: true,
  signedIn: true,
  out: false,
  next: true,
  windows: [],
  learned: [],
  ...over,
});

const inventory = (over: Partial<UsageInventory> = {}): UsageInventory => ({
  mode: 'normal',
  engines: [],
  accounts: [],
  local: [],
  spare: [],
  backlog: [],
  agents: [],
  routines: [],
  now: NOW,
  ...over,
});

describe('the capacity inventory, in words', () => {
  it('says "No reading yet" rather than a figure nobody reported', () => {
    expect(accountUsage(account(), NOW)).toEqual({ text: 'No reading yet', tone: 'calm' });
    expect(accountUsage(account({ signedIn: false }), NOW).text).toBe('Not signed in');
    expect(accountUsage(account({ out: true }), NOW).text).toBe(
      'Out of usage · refill time not reported'
    );
  });

  it('words a reading as reported, with its age once it is old', () => {
    const fresh = {
      kind: 'five_hour',
      usedPercent: 38.7,
      resetsAt: NOW + HOUR,
      limited: false,
      observedAt: NOW - 60_000,
    };
    expect(windowLine(fresh, NOW)).toMatch(/^5-hour 38% · refills /);
    const old = {
      ...fresh,
      kind: 'seven_day',
      resetsAt: NOW + 3 * 24 * HOUR,
      observedAt: NOW - 30 * HOUR,
    };
    expect(windowLine(old, NOW)).toMatch(/^Weekly 38% · refills \w+ · read yesterday$/);
    const warm = accountUsage(account({ windows: [{ ...fresh, usedPercent: 93 }] }), NOW);
    expect(warm.tone).toBe('warning');
  });

  it('labels every estimate as one, and has none without history', () => {
    expect(estimateLine(undefined)).toBeNull();
    expect(
      estimateLine({ estimate: true, tokens: 41_000, low: 1, high: 2, runs: 37, days: 5 })
    ).toBe('About 41k tokens a turn · estimate from 37 past runs');
    // Never a figure under five runs.
    expect(
      estimateLine({ estimate: true, tokens: 41_000, low: 1, high: 2, runs: 4, days: 1 })
    ).toBeNull();
  });

  it('names a plan only when the engine did', () => {
    expect(accountTags(account({ next: false }))).toEqual([]);
    expect(accountTags(account({ plan: 'plus' }))).toEqual(['Plus plan', 'Next turns run here']);
  });

  it('says what other compute was detected, never more', () => {
    expect(localLine({ name: 'OpenCode', models: [] })).toBe('OpenCode · installed');
    expect(localLine({ name: 'Ollama', running: false, models: [] })).toBe(
      'Ollama · installed, not running'
    );
    expect(localLine({ name: 'LM Studio', running: true, models: ['a', 'b', 'c', 'd'] })).toBe(
      'LM Studio · running · a, b, c +1'
    );
  });

  it('raises the spare-capacity line only for the account turns run on next', () => {
    const spare = {
      engine: 'claude' as const,
      accountId: 'w1',
      accountName: 'Work',
      next: false,
      kind: 'five_hour',
      usedPercent: 38,
      resetsAt: NOW + 40 * 60_000,
      observedAt: NOW - 10 * 60_000,
    };
    expect(spareLine(inventory({ spare: [spare] }), NOW)).toBeNull();
    const line = spareLine(
      inventory({
        mode: 'use_it_all',
        spare: [{ ...spare, next: true }],
        backlog: [{ id: 's', text: 't', addedBy: 'you', addedAt: 0, state: 'waiting' }],
      }),
      NOW
    );
    expect(line?.text).toMatch(/^Claude 5-hour limit refills .+ · 62% left$/);
    expect(line?.detail).toContain('ideas for leftover usage (1 waiting)');
    // A reset that has passed is history.
    expect(
      spareLine(inventory({ spare: [{ ...spare, next: true, resetsAt: NOW - 1 }] }), NOW)
    ).toBeNull();
    expect(spareLine(null)).toBeNull();
  });

  it('reads what a Mac really serves for agents.usagePlan, as the phone rows', () => {
    const rows = usageRows(real.agentsUsagePlan, real.agentsUsagePlan.now);
    expect(rows[0]).toMatchObject({ key: 'mode', label: 'Use it all before the refill' });
    expect(rows.map((r) => r.key)).toEqual([
      'mode',
      'spare',
      'est:claude',
      'backlog',
      'local:Ollama',
      'local:OpenCode',
    ]);
    expect(rows.find((r) => r.key === 'est:claude')?.detail).toContain(
      'estimate from 37 past runs'
    );
    // Its one item has started: none waiting.
    expect(rows.find((r) => r.key === 'backlog')?.value).toBe('0 waiting');
    expect(usageRows(null)).toEqual([]);
  });
});
