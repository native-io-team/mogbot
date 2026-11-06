import { describe, expect, it } from 'vitest';
import type { ComputeTotals, QuotaWindow, UsageAccountLine, UsageInventory } from './model';
import { computeForecast, computeRows, computeView } from './usageSheet';
import * as real from './fixtures.gen';

// A Thursday, noon local.
const NOW = new Date(2026, 10, 5, 12, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

const win = (kind: string, used: number, resetsIn: number, minutes?: number): QuotaWindow => ({
  kind,
  usedPercent: used,
  resetsAt: NOW + resetsIn,
  ...(minutes ? { windowMinutes: minutes } : {}),
  limited: used >= 100,
  observedAt: NOW - 5 * MIN,
});

const acct = (over: Partial<UsageAccountLine> & { id: string }): UsageAccountLine => ({
  engine: 'claude',
  name: over.id,
  thisMac: false,
  signedIn: true,
  out: false,
  next: false,
  windows: [],
  learned: [],
  ...over,
});

const totals = (over: Partial<ComputeTotals> = {}): ComputeTotals => ({
  accounts: 3,
  engines: [
    { engine: 'claude', accounts: 2, read: 2, room: 1 },
    { engine: 'codex', accounts: 1, read: 1, room: 1 },
  ],
  read: 3,
  room: 2,
  windows: [],
  ...over,
});

const inventory = (accounts: UsageAccountLine[], t?: ComputeTotals): UsageInventory => ({
  mode: 'normal',
  engines: [],
  accounts,
  local: [],
  spare: [],
  backlog: [],
  agents: [],
  routines: [],
  ...(t ? { totals: t } : {}),
  now: NOW,
});

const work = { engine: 'claude' as const, accountId: 'w', accountName: 'Work', at: NOW + 3 * HOUR };

describe('total compute', () => {
  it('says plainly what there is room on, and who is back first', () => {
    const some = computeView(inventory([], totals({ nextRoom: work })), NOW);
    expect(some?.headline).toBe(
      'You have room on 2 accounts right now. Claude · Work resets at 3:00 PM.'
    );
    expect(some?.summary).toBe('3 accounts · Claude 2, Codex 1');
    expect(some?.tone).toBe('calm');

    const all = computeView(inventory([], totals({ room: 3 })), NOW);
    expect(all?.headline).toBe('You have room on all 3 accounts right now.');

    const none = computeView(inventory([], totals({ room: 0, nextRoom: work })), NOW);
    expect(none?.headline).toBe(
      'No room on any account right now. Claude · Work resets first, at 3:00 PM.'
    );
    expect(none?.tone).toBe('limited');

    const one = computeView(
      inventory(
        [],
        totals({
          accounts: 1,
          read: 1,
          room: 1,
          engines: [{ engine: 'claude', accounts: 1, read: 1, room: 1 }],
        })
      ),
      NOW
    );
    expect(one?.headline).toBe('You have room on your account right now.');
    expect(one?.summary).toBe('1 account · Claude 1');
  });

  it('never counts an account it has no reading for', () => {
    const v = computeView(inventory([], totals({ accounts: 4, read: 3, room: 3 })), NOW);
    // Three read with room, one not read: not "all 4".
    expect(v?.headline).toBe('You have room on 3 accounts right now.');
    expect(v?.summary).toBe('4 accounts · Claude 2, Codex 1 · 1 not read yet');
    const blank = computeView(inventory([], totals({ read: 0, room: 0 })), NOW);
    expect(blank?.headline).toBe('No readings yet.');
  });

  it('says each kind of limit across accounts, with the soonest reset still to come', () => {
    const v = computeView(
      inventory(
        [],
        totals({
          windows: [
            { family: 'session', read: 3, room: 2, soonestReset: { ...work, at: NOW + 40 * MIN } },
            { family: 'weekly', read: 2, room: 1, soonestReset: { ...work, at: NOW - MIN } },
          ],
        })
      ),
      NOW
    );
    expect(v?.windows).toEqual([
      {
        key: 'session',
        label: '5-hour',
        text: '2 of 3 have room',
        reset: 'Soonest reset 12:40 PM · Claude · Work',
        tone: 'calm',
      },
      // A reset that has passed is history, not news.
      { key: 'weekly', label: 'Weekly', text: '1 of 2 has room', reset: null, tone: 'calm' },
    ]);
  });

  it('lists accounts most room first, then not read, then without room, then signed out', () => {
    const rows = computeRows(
      inventory([
        acct({
          id: 'out',
          out: true,
          outUntil: NOW + HOUR,
          windows: [win('five_hour', 100, HOUR)],
        }),
        acct({ id: 'gone', signedIn: false }),
        acct({ id: 'unread', check: { at: NOW, outcome: 'cant_read', why: 'x' } }),
        acct({
          id: 'roomy',
          windows: [win('five_hour', 10, HOUR), win('seven_day', 30, 50 * HOUR)],
        }),
        acct({
          id: 'tight',
          engine: 'codex',
          next: true,
          windows: [win('primary', 90, HOUR, 300)],
        }),
      ]),
      NOW
    );
    expect(rows.map((r) => r.title)).toEqual([
      'Claude · roomy',
      'Codex · tight',
      'Claude · unread',
      'Claude · out',
      'Claude · gone',
    ]);
    const roomy = rows[0];
    expect(roomy.session?.label).toBe('5-hour');
    expect(roomy.weekly?.label).toBe('Weekly');
    expect(roomy.state).toBeNull();
    expect(rows[1].next).toBe(true);
    expect(rows[1].session?.percent).toBe(90);
    expect(rows[2].state).toBe('No reading yet · runs to measure');
    expect(rows[3].state).toMatch(/^Out of usage until/);
    expect(rows[3].session).toBeNull();
    expect(rows[4].state).toBe('Not signed in');
  });

  it('says honestly why an account has no bars', () => {
    const state = (check?: UsageAccountLine['check']) =>
      computeRows(inventory([acct({ id: 'a', check })]), NOW)[0].state;
    expect(state(undefined)).toBe('No reading yet');
    expect(state({ at: NOW, outcome: 'cant_read' })).toBe('No reading yet · runs to measure');
    expect(state({ at: NOW, outcome: 'failed' })).toBe('No reading yet · couldn’t check just now');
    expect(state({ at: NOW, outcome: 'no_plan' })).toBe('No plan limits reported for this sign-in');
  });

  it('gives a row one pace line, its soonest, and no bar repeats it', () => {
    const [row] = computeRows(
      inventory([
        acct({
          id: 'a',
          windows: [win('five_hour', 60, 4 * HOUR), win('seven_day', 80, 60 * HOUR)],
          pace: [
            {
              estimate: true,
              kind: 'seven_day',
              resetsAt: NOW + 60 * HOUR,
              reachesAt: NOW + 30 * HOUR,
              readings: 9,
              spanMinutes: 600,
            },
            {
              estimate: true,
              kind: 'five_hour',
              resetsAt: NOW + 4 * HOUR,
              reachesAt: NOW + 2 * HOUR,
              readings: 6,
              spanMinutes: 95,
            },
          ],
        }),
      ]),
      NOW
    );
    expect(row.pace?.text).toMatch(/^5-hour: At this pace you’ll hit the limit in about 2 hours/);
    expect(row.pace?.basis).toBe('Estimate from 6 readings over 2 hours');
    expect(row.session?.pace).toBeUndefined();
    expect(row.weekly?.pace).toBeUndefined();
  });

  it('only shows a per-model limit when it is nearly used up', () => {
    const rows = (used: number) =>
      computeRows(
        inventory([
          acct({
            id: 'a',
            windows: [win('five_hour', 10, HOUR), win('seven_day_opus', used, 50 * HOUR)],
          }),
        ]),
        NOW
      )[0].extra;
    expect(rows(40)).toEqual([]);
    expect(rows(95).map((m) => m.label)).toEqual(['Weekly · Opus']);
  });

  it('forecasts across accounts only from the Mac’s estimate, labelled with what it rests on', () => {
    const runOut = [
      {
        estimate: true as const,
        engine: 'claude' as const,
        reachesAt: NOW + 2.5 * HOUR,
        readings: 13,
        accounts: 2,
      },
    ];
    const f = computeForecast(inventory([], totals({ runOut })), NOW);
    expect(f).toEqual({
      text: 'At this pace you’ll run out of Claude on every account in about 3 hours; Codex has room.',
      basis: 'Estimate from 13 readings across 2 accounts',
    });
    const later = computeForecast(
      inventory([], totals({ runOut: [{ ...runOut[0], reachesAt: NOW + 26 * HOUR }] })),
      NOW
    );
    expect(later?.text).toBe(
      'At this pace you’ll run out of Claude on every account by tomorrow afternoon; Codex has room.'
    );
    // None sent, or one whose moment has passed: nothing, never a guess.
    expect(computeForecast(inventory([], totals()), NOW)).toBeNull();
    expect(
      computeForecast(
        inventory([], totals({ runOut: [{ ...runOut[0], reachesAt: NOW - 1 }] })),
        NOW
      )
    ).toBeNull();
  });

  it('is absent from a Mac that serves no totals', () => {
    expect(computeView(inventory([acct({ id: 'a' })]), NOW)).toBeNull();
    expect(computeView(null, NOW)).toBeNull();
  });

  it('reads what a Mac really serves for agents.usagePlan', () => {
    const served = real.agentsUsagePlan;
    const v = computeView(served, served.now);
    expect(v).not.toBeNull();
    expect(v?.summary).toBe('3 accounts · Claude 2, Codex 1');
    expect(v?.headline).toMatch(/^You have room on 2 accounts right now\. Codex · Plus resets /);
    expect(v?.forecast?.text).toMatch(/^At this pace you’ll run out of Claude on every account /);
    expect(v?.forecast?.basis).toBe('Estimate from 11 readings across 2 accounts');
    expect(v?.rows.map((r) => r.title)).toEqual([
      'Claude · This Mac',
      'Claude · Work',
      'Codex · Plus',
    ]);
  });
});
