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
  const mac = acct({
    id: 'mac',
    name: 'This Mac',
    thisMac: true,
    next: true,
    plan: 'max',
    windows: [win('five_hour', 7, 3 * HOUR), win('seven_day', 71, 100 * HOUR)],
  });
  const personal = acct({
    id: 'p',
    name: 'Personal',
    windows: [win('five_hour', 20, 2 * HOUR), win('seven_day', 40, 60 * HOUR)],
  });
  const codexOut = acct({ id: 'cx', name: 'This Mac', engine: 'codex', signedIn: false });
  const one = (over: Partial<ComputeTotals> = {}) =>
    totals({
      accounts: 3,
      signedIn: 2,
      read: 1,
      room: 1,
      engines: [
        { engine: 'claude', accounts: 2, read: 1, room: 1 },
        { engine: 'codex', accounts: 1, read: 0, room: 0 },
      ],
      ...over,
    });
  const unread = acct({
    id: 'p',
    name: 'Personal',
    check: { at: NOW, outcome: 'cant_read', why: 'Can’t read its limits between turns' },
  });

  it('names the one account read, and says nothing the cards already do', () => {
    const v = computeView(inventory([mac, unread, codexOut], one()), NOW);
    expect(v?.headline).toBe('Room now on Claude Max');
    expect(v?.detail).toBeNull();
    expect(v?.tone).toBe('calm');
    expect(v?.estimate).toBeNull();
    // A card for the account with bars; the rest compact and quiet.
    expect(v?.rows.map((r) => r.title)).toEqual(['Claude Max']);
    expect(v?.quiet.map((r) => r.title)).toEqual(['Claude · Personal', 'Codex account']);
  });

  it('says an account’s run-out estimate under the bar it is about, and tints that bar', () => {
    const paced = {
      ...mac,
      pace: [
        {
          estimate: true as const,
          kind: 'seven_day',
          resetsAt: NOW + 100 * HOUR,
          reachesAt: NOW + 34 * HOUR,
          readings: 200,
          spanMinutes: 600,
        },
      ],
    };
    const v = computeView(inventory([paced, unread, codexOut], one()), NOW);
    expect(v?.headline).toBe('Room now on Claude Max');
    // Not in the headline: under its own bar, short, said as an estimate.
    expect(v?.estimate).toBeNull();
    const row = v?.rows[0];
    expect(row?.title).toBe('Claude Max');
    expect(row?.weekly?.pace).toEqual({
      text: 'At this pace it runs out tomorrow night',
      basis: 'Estimate from 200 readings over 10 hours',
    });
    expect(row?.session?.pace).toBeUndefined();
    expect(row?.weekly?.tone).toBe('warning');
    expect(row?.session?.tone).toBe('calm');
  });

  it('says how many have room without listing them, and Used next only with a choice', () => {
    const v = computeView(
      inventory(
        [mac, personal, codexOut],
        one({
          read: 2,
          room: 2,
          engines: [
            { engine: 'claude', accounts: 2, read: 2, room: 2 },
            { engine: 'codex', accounts: 1, read: 0, room: 0 },
          ],
          windows: [
            { family: 'session', read: 2, room: 2, soonestReset: { ...work, at: NOW + 40 * MIN } },
            { family: 'weekly', read: 2, room: 2, soonestReset: { ...work, at: NOW - MIN } },
          ],
        })
      ),
      NOW
    );
    expect(v?.headline).toBe('Room now on both accounts');
    expect(v).not.toHaveProperty('summary');
    expect(v).not.toHaveProperty('windows');
    // "Used next" only where its engine has a choice of account.
    expect(v?.rows.find((r) => r.title === 'Claude Max')?.tags).toEqual(['Max plan', 'Used next']);
    const solo = computeRows(inventory([{ ...mac }, codexOut]), NOW);
    expect(solo[0].tags).toEqual(['Max plan']);
  });

  it('counts a signed-in account it has no reading for as not read, never as room', () => {
    const v = computeView(
      inventory(
        [mac, personal, unread, codexOut].map((a, i) => ({ ...a, id: `${a.id}${i}` })),
        totals({ accounts: 4, signedIn: 3, read: 2, room: 2 })
      ),
      NOW
    );
    expect(v?.headline).toBe('Room now on both accounts');
    expect(v?.quiet.map((r) => r.state)).toEqual([
      'Can’t read its limits between turns',
      'Not signed in',
    ]);
    const tight = { ...personal, windows: [win('five_hour', 100, 2 * HOUR)] };
    expect(computeView(inventory([mac, tight], totals()), NOW)?.headline).toBe(
      'Room now on Claude Max'
    );
    const third = acct({ id: 'x', name: 'X', windows: [win('five_hour', 100, HOUR)] });
    expect(computeView(inventory([mac, personal, third], totals()), NOW)?.headline).toBe(
      'Room now on 2 of 3 accounts'
    );
  });

  it('says when there is no room, and who has room again first', () => {
    const out = acct({
      id: 'w',
      name: 'Work',
      out: true,
      outUntil: NOW + 3 * HOUR,
      windows: [win('five_hour', 100, 3 * HOUR)],
    });
    const v = computeView(inventory([out], totals({ read: 1, room: 0, nextRoom: work })), NOW);
    expect(v?.headline).toBe('No room right now');
    expect(v?.detail).toBe('Claude · Work has room again at 3:00 PM');
    expect(v?.tone).toBe('limited');
    expect(v?.rows).toEqual([]);
    expect(v?.quiet[0].state).toMatch(/^Out until/);
    expect(computeView(inventory([unread], totals({ read: 0, room: 0 })), NOW)?.headline).toBe(
      'No limits read yet'
    );
    expect(computeView(inventory([codexOut], totals({ read: 0, room: 0 })), NOW)?.headline).toBe(
      'No account is signed in'
    );
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
        acct({ id: 'unread', check: { at: NOW, outcome: 'cant_read', why: 'Its why' } }),
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
    // The Mac's own words for why.
    expect(rows[2].state).toBe('Its why');
    expect(rows[3].state).toMatch(/^Out until/);
    expect(rows[3].session).toBeNull();
    expect(rows[4].state).toBe('Not signed in');
    expect(rows[4].tone).toBe('calm');
  });

  it('says honestly why an account has no bars, never that it will turn up by itself', () => {
    const state = (check?: UsageAccountLine['check']) =>
      computeRows(inventory([acct({ id: 'a', check })]), NOW)[0].state;
    expect(state(undefined)).toBe('Not checked yet');
    expect(state({ at: NOW, outcome: 'cant_read' })).toBe('Can’t read its limits between turns');
    expect(state({ at: NOW, outcome: 'failed' })).toBe('Couldn’t check its limits just now');
    expect(state({ at: NOW, outcome: 'no_plan' })).toBe('No plan limits reported for this sign-in');
    for (const s of [
      state(undefined),
      state({ at: NOW, outcome: 'cant_read' }),
      state({ at: NOW, outcome: 'failed' }),
    ]) {
      expect(s).not.toMatch(/runs to measure|will appear|soon/i);
    }
  });

  it('puts each pace line under its own bar, and none on a used-up one', () => {
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
    expect(row.session?.pace).toEqual({
      text: 'At this pace it runs out in about 2 hours',
      basis: 'Estimate from 6 readings over 2 hours',
    });
    expect(row.weekly?.pace?.text).toBe('At this pace it runs out tomorrow evening');
    expect(row.session?.tone).toBe('warning');
    expect(row.weekly?.tone).toBe('warning');
    expect(row).not.toHaveProperty('pace');
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
    expect(v?.headline).toBe('Room now on 2 of 3 accounts');
    expect(v?.estimate?.text).toMatch(/^At this pace you’ll run out of Claude on every account /);
    expect(v?.estimate?.basis).toBe('Estimate from 11 readings across 2 accounts');
    expect(v?.rows.map((r) => r.title)).toEqual(['Claude · Example', 'Claude · Work']);
    expect(v?.quiet.map((r) => r.title)).toEqual(['Codex · Plus']);
  });
});
