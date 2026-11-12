import { describe, expect, it } from 'vitest';
import type { UsageAccount, UsageAccountLine, UsageInventory } from './model';
import {
  accountDisplayName,
  changeLines,
  glanceUsed,
  relativeIn,
  shortCountdown,
  runsOnRows,
  totalWords,
  usageGlance,
  usedFigure,
  usedTone,
  usersLine,
  weightingOf,
  type UsageTotal,
} from './usageGlance';

const NOW = new Date(2026, 10, 9, 12, 0).getTime();
const H = 3_600_000;

const acct = (id: string, over: Partial<UsageAccount> = {}): UsageAccount => ({
  id,
  engine: 'claude',
  name: id,
  thisMac: id === 'default',
  signedIn: true,
  out: false,
  ...over,
});

const line = (id: string, over: Partial<UsageAccountLine> = {}): UsageAccountLine => ({
  engine: 'claude',
  id,
  name: id,
  thisMac: id === 'default',
  signedIn: true,
  out: false,
  next: false,
  windows: [],
  learned: [],
  ...over,
});

const week = (used: number, resetsIn = 50 * H) => ({
  kind: 'seven_day',
  usedPercent: used,
  resetsAt: NOW + resetsIn,
  limited: false,
  observedAt: NOW - 60_000,
});

const inv = (accounts: UsageAccountLine[], over: Partial<UsageInventory> = {}): UsageInventory => ({
  mode: 'normal',
  engines: [],
  accounts,
  local: [],
  spare: [],
  backlog: [],
  agents: [],
  routines: [],
  now: NOW,
  ...over,
});

describe('usageGlance', () => {
  it('stacks every account in order, filled to what each reading left', () => {
    const g = usageGlance(
      [acct('default', { name: 'sam@example.com', plan: 'Max' }), acct('work', { name: 'Work' })],
      inv([line('default', { windows: [week(22)] }), line('work', { windows: [week(70)] })]),
      { now: NOW }
    );
    expect(g.keys.map((k) => [k.name, k.left, k.state])).toEqual([
      ['sam@example.com', 78, 'in_use'],
      ['Work', 30, 'next'],
    ]);
    expect(g.headline).toBe('Plenty of room');
    expect(g.summary).toMatch(/^2 accounts · refills /);
    expect(g.keys[0].detail).toContain('Max plan');
    expect(g.low).toBeNull();
  });

  it('never fills an account it has no reading of', () => {
    const g = usageGlance([acct('default')], inv([line('default')]), { now: NOW });
    expect(g.keys[0].left).toBeNull();
    expect(g.keys[0].tone).toBe('quiet');
    expect(g.headline).toBe('Your usage shows here after an agent’s first reply.');
  });

  it('a second sign-in of the same account adds no room and says how to fix it', () => {
    const g = usageGlance(
      [
        acct('default', { name: 'sam@example.com' }),
        acct('p', { name: 'Personal Account', email: 'sam@example.com' }),
      ],
      inv([
        line('default', { windows: [week(22)] }),
        line('p', { windows: [week(21)], sameAs: 'sam@example.com' }),
      ]),
      { now: NOW }
    );
    const p = g.keys[1];
    expect(p.state).toBe('same');
    expect(p.stateLabel).toBe('Same account');
    expect(p.fix?.text).toBe('Same Claude account as sam@example.com — adds no extra room.');
    // Not a segment of the meter: one line under it instead.
    expect(g.meterKeys.map((k) => k.id)).toEqual(['default']);
    expect(g.sameNotes).toEqual([
      'Personal Account is the same Claude account as sam@example.com — adds no extra room',
    ]);
    // The row never says "accounts" for one real account.
    expect(g.row.count).toBeNull();
    expect(p.left).toBeNull();
    expect(p.limits).toEqual([]);
    expect(p.canUse).toBe(false);
    expect(p.fix?.action).toBe('sign_in_other');
    // Counted once.
    expect(g.summary).toMatch(/^1 account · /);
  });

  it('two meters moving together are a question, never counted as one', () => {
    const g = usageGlance(
      [acct('default', { name: 'sam@example.com' }), acct('w', { name: 'Work' })],
      inv([
        line('default', { windows: [week(42)] }),
        line('w', { windows: [week(42)], maybeSameAs: 'default' }),
      ]),
      { now: NOW }
    );
    expect(g.sameNotes).toEqual([
      'Work and sam@example.com may be the same Claude account: their weekly limits have moved together and refill at the same moment. If they are, sign one in with a different account.',
    ]);
    // Still two accounts on the meter and in the totals.
    expect(g.meterKeys.map((k) => k.id)).toEqual(['default', 'w']);
    expect(g.keys[1].state).not.toBe('same');
    expect(g.summary).toMatch(/^2 accounts · /);
  });

  it('out everywhere says until when, in the one phrase', () => {
    const g = usageGlance(
      [acct('default', { out: true, limit: { at: NOW - H, resetsAt: NOW + 3 * H } })],
      inv([line('default', { out: true, outUntil: NOW + 3 * H, windows: [week(100)] })], {
        totals: {
          accounts: 1,
          engines: [],
          read: 1,
          room: 0,
          windows: [],
          nextRoom: {
            engine: 'claude',
            accountId: 'default',
            accountName: 'default',
            at: NOW + 3 * H,
          },
        },
      }),
      { now: NOW }
    );
    expect(g.headline).toMatch(/^Out until /);
    expect(g.tone).toBe('limited');
    expect(g.keys[0].stateLabel).toMatch(/^Out until /);
    expect(g.low?.waitUntil).toMatch(/^Wait until /);
  });

  it('one account out and the rest never read is that account, not "out of usage"', () => {
    const g = usageGlance(
      [acct('default'), acct('work', { name: 'Work', out: true }), acct('p', { name: 'Personal' })],
      inv([
        line('default'),
        line('work', { name: 'Work', out: true, windows: [week(100)] }),
        line('p', { name: 'Personal' }),
      ]),
      { now: NOW }
    );
    expect(g.headline).toBe('Work is out');
    expect(g.row.figure).toBe('Work is out');
    expect(g.low).toBeNull();
  });

  it('nearly empty everywhere offers the options', () => {
    const g = usageGlance(
      [acct('default'), acct('w')],
      inv([line('default', { windows: [week(95)] }), line('w', { windows: [week(97)] })]),
      { now: NOW }
    );
    expect(g.headline).toBe('Nearly out on every account');
    expect(g.low?.text).toBe('Every account is nearly out of usage.');
  });

  it('a run-out estimate says so, with what it rests on', () => {
    const g = usageGlance(
      [acct('default'), acct('w')],
      inv(
        [
          line('default', { windows: [week(60, 5 * 24 * H)] }),
          line('w', { windows: [week(50, 5 * 24 * H)] }),
        ],
        {
          totals: {
            accounts: 2,
            engines: [],
            read: 2,
            room: 2,
            windows: [],
            runOut: [
              {
                estimate: true,
                engine: 'claude',
                reachesAt: NOW + 2 * 24 * H,
                readings: 9,
                accounts: 2,
              },
            ],
          },
        }
      ),
      { now: NOW }
    );
    expect(g.headline).toMatch(/^Runs out ~.*, 3 days before the refill$/);
    expect(g.estimate).toBe('Estimate from 9 readings across 2 accounts');
    // An estimate is information, not "needs you": never the warning tone.
    expect(g.tone).toBe('calm');
  });

  it('a pace estimate never turns a limit amber; only nearly out does', () => {
    const pace = (used: number) =>
      line('default', {
        windows: [week(used, 5 * 24 * H)],
        pace: [
          {
            kind: 'seven_day',
            estimate: true,
            reachesAt: NOW + 24 * H,
            resetsAt: NOW + 5 * 24 * H,
            readings: 6,
            spanMinutes: 180,
          },
        ],
      });
    const calm = usageGlance([acct('default')], inv([pace(40)]), { now: NOW }).keys[0];
    expect(calm.limits[0].pace?.text).toMatch(/^At this pace it runs out /);
    expect(calm.limits[0].tone).toBe('calm');
    expect(calm.tone).toBe('calm');
    const low = usageGlance([acct('default')], inv([pace(95)]), { now: NOW }).keys[0];
    expect(low.limits[0].tone).toBe('warning');
  });

  it('never names an account "This Mac": its email, else its plan, else the engine', () => {
    const named = (a: Partial<UsageAccount>, l: Partial<UsageAccountLine> = {}) =>
      usageGlance([acct('default', a)], inv([line('default', l)]), { now: NOW }).keys[0];
    expect(named({ name: 'This Mac' }).name).toBe('Claude Code account');
    expect(named({ name: 'Signed in on this Mac', named: false }).name).toBe('Claude Code account');
    expect(named({ name: 'This Mac', email: 'sam@example.com' }).name).toBe('sam@example.com');
    expect(named({ name: 'This Mac', plan: 'max' }).name).toBe('Claude Max');
    expect(named({ name: 'This Mac' }, { orgName: 'Acme' }).name).toBe('Acme');
    expect(named({ name: 'This Mac' }, { orgName: 'Sam’s Organization' }).name).toBe(
      'Claude Code account'
    );
    // What the user named it wins; where it's signed in stays a detail.
    const work = named({ name: 'Work', named: true, email: 'sam@example.com', plan: 'max' });
    expect(work.name).toBe('Work');
    expect(work.detail).toEqual(['Max plan', 'sam@example.com', 'this computer’s own sign-in']);
    // The plan isn't said twice when it is the name.
    expect(named({ name: 'This Mac', plan: 'max' }).detail).toEqual([
      'this computer’s own sign-in',
    ]);
  });

  it('a second sign-in names the first by its key’s name, not the Mac’s "This Mac"', () => {
    const g = usageGlance(
      [acct('default', { name: 'This Mac', email: 'sam@example.com' }), acct('p', { name: 'P' })],
      inv([
        line('default', { name: 'This Mac', windows: [week(22)] }),
        line('p', { windows: [week(21)], sameAs: 'This Mac' }),
      ]),
      { now: NOW }
    );
    expect(g.keys[1].sameAs).toBe('sam@example.com');
  });

  it('a run-out within the hour says "in about" once, never "~in about"', () => {
    const g = usageGlance(
      [acct('default')],
      inv([line('default', { windows: [week(90, 3 * 24 * H)] })], {
        totals: {
          accounts: 1,
          engines: [],
          read: 1,
          room: 1,
          windows: [],
          runOut: [
            {
              estimate: true,
              engine: 'claude',
              reachesAt: NOW + 50 * 60_000,
              readings: 9,
              accounts: 1,
            },
          ],
        },
      }),
      { now: NOW }
    );
    expect(g.headline).toBe('Runs out in about 50 minutes, 3 days before the refill');
  });

  it('a reset soon with lots left nudges, with what it would spend it on', () => {
    const g = usageGlance(
      [acct('default', { name: 'Work' })],
      inv([line('default', { name: 'Work', next: true, windows: [week(38, 9 * H)] })], {
        spare: [
          {
            engine: 'claude',
            accountId: 'default',
            accountName: 'Work',
            next: true,
            kind: 'seven_day',
            usedPercent: 38,
            resetsAt: NOW + 9 * H,
            observedAt: NOW,
          },
        ],
        backlog: [
          { id: '1', text: 'Tidy the docs', addedBy: 'you', addedAt: 0, state: 'waiting' },
          { id: '2', text: 'Old', addedBy: 'you', addedAt: 0, state: 'started' },
        ],
      }),
      { now: NOW }
    );
    expect(g.nudge?.text).toBe('62% of Work’s week refills in 9 h');
    expect(g.nudge?.items).toEqual(['Tidy the docs']);
    expect(g.nudge?.empty).toBe(false);
  });

  it('the nudge names the account as its key does, not the inventory’s “This Mac”', () => {
    const g = usageGlance(
      [acct('default', { name: 'sam@example.com' })],
      inv([line('default', { name: 'This Mac', next: true, windows: [week(38, 9 * H)] })], {
        spare: [
          {
            engine: 'claude',
            accountId: 'default',
            accountName: 'This Mac',
            next: true,
            kind: 'seven_day',
            usedPercent: 38,
            resetsAt: NOW + 9 * H,
            observedAt: NOW,
          },
        ],
      }),
      { now: NOW }
    );
    expect(g.keys[0].name).toBe('sam@example.com');
    expect(g.nudge?.text).toBe('62% of sam@example.com’s week refills in 9 h');
  });

  it('two accounts with one name never read the same', () => {
    const g = usageGlance([acct('a', { name: 'Work' }), acct('b', { name: 'Work' })], inv([]), {
      now: NOW,
    });
    expect(g.keys.map((k) => k.name)).toEqual(['Work (1)', 'Work (2)']);
  });
});

describe('where did my usage go', () => {
  it('lists what ran, and says plainly when nothing here explains it', () => {
    const lines = changeLines(
      'claude',
      [
        {
          kind: 'seven_day',
          from: 32,
          to: 67,
          since: NOW - 10 * H,
          until: NOW - H,
          runs: [],
          nothingHere: true,
        },
        {
          kind: 'five_hour',
          from: 10,
          to: 30,
          since: NOW - 20 * H,
          until: NOW - 18 * H,
          runs: [
            { agentId: 'r', name: 'Riley', routine: 'Morning brief', turns: 3, tokens: 1_200_000 },
          ],
          nothingHere: false,
        },
      ],
      NOW
    );
    expect(lines[0].title).toBe('Weekly 32% → 67% used');
    expect(lines[0].elsewhere).toMatch(/^Nothing these agents ran explains this/);
    expect(lines[1].runs).toEqual(['Riley: Morning brief · 3 messages · 1.2M tokens']);
    expect(lines[1].elsewhere).toBeNull();
  });

  it('says when, relative and short', () => {
    expect(relativeIn(NOW + 40 * 60_000, NOW)).toBe('in 40 min');
    expect(relativeIn(NOW + 9 * H, NOW)).toBe('in 9 h');
    expect(relativeIn(NOW + 5 * 24 * H, NOW)).toBe('in 5 days');
  });
});

describe('the row, in plain words', () => {
  it('says what is left of the tighter limit, and when it refills', () => {
    const g = usageGlance(
      [acct('default', { name: 'sam@example.com' })],
      inv([line('default', { windows: [week(43, 5 * 24 * H)] })]),
      { now: NOW }
    );
    expect(g.row.figure).toBe('43% used this week');
    expect(g.row.refill).toMatch(/^Refills /);
    expect(g.row.count).toBeNull();
    expect(g.row.needsYou).toBe(false);
  });

  it('counts accounts only when there is more than one real one', () => {
    const g = usageGlance(
      [acct('default'), acct('work', { name: 'Work' })],
      inv([line('default', { windows: [week(22)] }), line('work', { windows: [week(70)] })]),
      { now: NOW }
    );
    expect(g.row.count).toBe('2 accounts');
  });

  it('counts the accounts the figure is of: one not read yet is not one of them', () => {
    const g = usageGlance(
      [acct('default'), acct('work', { name: 'Work' }), acct('new', { name: 'New' })],
      inv([line('default', { windows: [week(22)] }), line('work', { windows: [week(70)] })]),
      { now: NOW }
    );
    expect(g.total.counted).toBe(2);
    expect(g.row.count).toBe('2 accounts');
  });

  it('says plainly when nothing has been read, and never a figure', () => {
    const g = usageGlance([acct('default')], inv([line('default')]), { now: NOW });
    expect(g.row).toEqual({
      figure: 'Not read yet',
      refill: null,
      count: null,
      notRead: null,
      needsYou: false,
    });
  });
});

describe('every limit, against pace', () => {
  // A week with 3.5 days to go: half the time is left.
  const half = 3.5 * 24 * H;

  it('marks where an even pace would stand, and says whether it is ahead', () => {
    const under = usageGlance(
      [acct('default')],
      inv([line('default', { windows: [week(20, half)] })]),
      {
        now: NOW,
      }
    ).keys[0].limits[0];
    expect(under.evenLeft).toBe(50);
    expect(under.paceState).toBe('under');
    expect(under.paceWord).toBe('Under pace — room to spare before it refills');
    expect(under.countdown).toBe('3d 12h');

    const on = usageGlance(
      [acct('default')],
      inv([line('default', { windows: [week(52, half)] })]),
      {
        now: NOW,
      }
    ).keys[0].limits[0];
    expect(on.paceWord).toBe('On pace — lasts until it refills');
  });

  it('a run-out is the Mac’s estimate, placed along the time left and said in words', () => {
    const g = usageGlance(
      [acct('default')],
      inv([
        line('default', {
          windows: [week(80, half)],
          pace: [
            {
              estimate: true,
              kind: 'seven_day',
              resetsAt: NOW + half,
              reachesAt: NOW + 1.5 * 24 * H,
              readings: 9,
              spanMinutes: 3000,
            },
          ],
        }),
      ]),
      { now: NOW }
    );
    const l = g.keys[0].limits[0];
    expect(l.paceState).toBe('ahead');
    expect(l.runOut?.along).toBeCloseTo(1.5 / 3.5);
    expect(l.paceWord).toMatch(
      /^Ahead of pace — at this rate it runs out .+, 2 days before it refills$/
    );
  });

  it('a per-model limit is its own card and never the account’s room', () => {
    const g = usageGlance(
      [acct('default')],
      inv([
        line('default', {
          windows: [week(20), { ...week(95), kind: 'seven_day_opus' }],
        }),
      ]),
      { now: NOW }
    );
    expect(g.keys[0].limits.map((l) => l.label)).toEqual(['Weekly', 'Weekly · Opus']);
    expect(g.keys[0].left).toBe(80);
  });

  it('adds up who used the real accounts this week, never a duplicate’s', () => {
    const runs = [{ agentId: 'c', name: 'Chief', turns: 3, tokens: 3000 }];
    const g = usageGlance(
      [acct('default'), acct('p', { name: 'P' })],
      inv([
        line('default', { windows: [week(20)], spent: runs }),
        line('p', { windows: [week(20)], sameAs: 'default', spent: runs }),
      ]),
      { now: NOW }
    );
    expect(g.burning).toEqual([
      { key: 'c', name: 'Chief', tokens: 3000, detail: '3k tokens · 3 messages', share: 100 },
    ]);
  });
});

describe('this Mac signed in as another account', () => {
  const MON_4PM = new Date(2026, 10, 2, 16, 0).getTime();
  const SAT_10AM = new Date(2026, 10, 7, 10, 0).getTime();
  const accounts = [acct('default', { name: 'me@example.com' })];

  it('names the previous account and its reset, from what was recorded', () => {
    const g = usageGlance(
      accounts,
      inv([line('default', { windows: [week(20)] })], {
        signInChanges: [
          {
            engine: 'claude',
            key: 'claude:1',
            at: NOW - H,
            nowEmail: 'me@example.com',
            beforeEmail: 'work@example.com',
            beforeWeeklyReset: MON_4PM,
            byReset: false,
          },
        ],
      }),
      { now: NOW }
    );
    expect(g.signInChanged?.key).toBe('claude:1');
    expect(g.signInChanged?.text).toBe(
      'This computer’s Claude Code is now signed in as me@example.com. Your previous account (work@example.com, refills Mondays 4 PM) isn’t connected anymore — add it to keep stacking.'
    );
  });

  it('when only the reset moved, says that, and names nobody', () => {
    const g = usageGlance(
      accounts,
      inv([line('default', { windows: [week(20)] })], {
        signInChanges: [
          {
            engine: 'claude',
            key: 'claude:moved:1',
            at: NOW - H,
            nowEmail: 'me@example.com',
            beforeWeeklyReset: MON_4PM,
            nowWeeklyReset: SAT_10AM,
            byReset: true,
          },
        ],
      }),
      { now: NOW }
    );
    expect(g.signInChanged?.text).toBe(
      'This computer’s Claude Code is now signed in as me@example.com, whose week refills Saturdays 10 AM. It used to refill Mondays 4 PM, so that was another Claude account, and it isn’t connected anymore — add it to keep stacking.'
    );
  });

  it('says nothing when the Mac said nothing', () => {
    const g = usageGlance(accounts, inv([line('default', { windows: [week(20)] })]), {
      now: NOW,
    });
    expect(g.signInChanged).toBeNull();
  });
});

describe('the total, across every account', () => {
  it('averages each account’s week, in the work order: 100% and 44% read as 72%', () => {
    const g = usageGlance(
      [acct('default', { name: 'sam@example.com' }), acct('work', { name: 'Work' })],
      inv([
        line('default', { windows: [week(56, 2 * 24 * H)] }),
        line('work', { windows: [week(0, 5 * 24 * H)] }),
      ]),
      { now: NOW }
    );
    expect(g.total.left).toBe(72);
    expect(g.total.figure).toBe('28% used');
    expect(g.total.across).toBe('across 2 accounts');
    // The bar and the list below it share one order: the work order (round 4).
    expect(g.keys.map((k) => k.name)).toEqual(['sam@example.com', 'Work']);
    expect(g.total.segments.map((s) => [s.name, s.left])).toEqual([
      ['sam@example.com', 44],
      ['Work', 100],
    ]);
    // The next refill is the soonest of the weeks counted.
    expect(g.total.refill).toMatchObject({ in: '2d 0h', account: 'sam@example.com' });
    expect(g.row.figure).toBe('28% used');
    expect(g.row.count).toBe('2 accounts');
    expect(g.row.refill).toBe('Refills in 2d 0h');
  });

  it('names the plan when every account counted is on the same one', () => {
    const g = usageGlance(
      [acct('default', { plan: 'max' }), acct('work', { plan: 'max' })],
      inv([line('default', { windows: [week(20)] }), line('work', { windows: [week(40)] })]),
      { now: NOW }
    );
    expect(g.total.across).toBe('across 2 Max accounts');
    const mixed = usageGlance(
      [acct('default', { plan: 'max' }), acct('work', { plan: 'pro' })],
      inv([line('default', { windows: [week(20)] }), line('work', { windows: [week(40)] })]),
      { now: NOW }
    );
    expect(mixed.total.across).toBe('across 2 accounts');
  });

  it('leaves out a second sign-in of the same account', () => {
    const g = usageGlance(
      [acct('default', { name: 'sam@example.com' }), acct('p', { name: 'Personal' })],
      inv([
        line('default', { windows: [week(50)] }),
        line('p', { windows: [week(50)], sameAs: 'sam@example.com' }),
      ]),
      { now: NOW }
    );
    expect(g.total.counted).toBe(1);
    expect(g.total.left).toBe(50);
    expect(g.total.segments.map((s) => s.name)).toEqual(['sam@example.com']);
    expect(g.total.across).toBe('this week');
    expect(g.row.figure).toBe('50% used this week');
    expect(g.row.count).toBeNull();
  });

  it('shows an account with no reading as unknown, never as room, and doesn’t count it', () => {
    const g = usageGlance(
      [acct('default'), acct('work', { name: 'Work' }), acct('new', { name: 'New' })],
      inv([line('default', { windows: [week(70)] }), line('work'), line('new')]),
      { now: NOW }
    );
    expect(g.total.left).toBe(30);
    expect(g.total.counted).toBe(1);
    expect(g.total.unread).toBe('2 accounts not read yet, not counted');
    // Last, and empty.
    expect(g.total.segments.map((s) => [s.name, s.left])).toEqual([
      ['default', 30],
      ['Work', null],
      ['New', null],
    ]);
    expect(g.total.segments[1].words).toBe('Work: shows after its first reply');

    const none = usageGlance([acct('default')], inv([line('default')]), { now: NOW });
    expect(none.total.left).toBeNull();
    expect(none.total.figure).toBe('Not read yet');
    expect(none.total.across).toBe('');
  });

  it('an account out of usage counts as nothing left, in its place in the order', () => {
    const g = usageGlance(
      [acct('default', { name: 'A' }), acct('b', { name: 'B' }), acct('c', { name: 'C' })],
      inv([
        line('default', { windows: [week(40)], out: true, outUntil: NOW + 3 * H }),
        line('b', { windows: [week(10)] }),
        line('c', { windows: [week(60)] }),
      ]),
      { now: NOW }
    );
    expect(g.total.segments.map((s) => [s.name, s.left])).toEqual([
      ['A', 0],
      ['B', 90],
      ['C', 40],
    ]);
    expect(g.total.left).toBe(43);
  });

  it('uses the tighter limit only when an engine reported no week', () => {
    const fiveHour = {
      kind: 'five_hour',
      usedPercent: 38,
      resetsAt: NOW + 2 * H,
      limited: false,
      observedAt: NOW,
    };
    const g = usageGlance([acct('default')], inv([line('default', { windows: [fiveHour] })]), {
      now: NOW,
    });
    expect(g.total.left).toBe(62);
    expect(g.total.across).toBe('for now');
    expect(g.row.figure).toBe('38% used for now');
  });

  it('lists who used an account as rows, most first, with each one’s share', () => {
    const g = usageGlance(
      [acct('default')],
      inv([
        line('default', {
          windows: [week(20)],
          spent: [
            { agentId: 'f', name: 'Finance', turns: 2, tokens: 250_000 },
            { agentId: 'c', name: 'Chief', turns: 9, tokens: 750_000 },
          ],
        }),
      ]),
      { now: NOW }
    );
    expect(g.keys[0].agents.map((a) => [a.name, a.tokensText, a.turnsText, a.share])).toEqual([
      ['Chief', '750k', '9 messages', 75],
      ['Finance', '250k', '2 messages', 25],
    ]);
  });
});

describe('the one bar: a total across accounts, never a segment each', () => {
  const two = (a: number, b: number, plans: [string?, string?] = []) =>
    usageGlance(
      [
        acct('default', { name: 'sam@example.com', plan: plans[0] }),
        acct('work', { name: 'Work', plan: plans[1] }),
      ],
      inv([line('default', { windows: [week(a)] }), line('work', { windows: [week(b)] })]),
      { now: NOW }
    );

  it('two Max plans at 50% each are 50% in total, one bar half full', () => {
    const g = two(50, 50, ['max', 'max']);
    expect(g.total.left).toBe(50);
    expect(g.total.figure).toBe('50% used');
    expect(g.total.tone).toBe('calm');
    expect(g.row.figure).toBe('50% used');
    expect(g.row.count).toBe('2 accounts');
    expect(g.total.weighting).toBe('Both on Max, so each counts the same.');
  });

  it('one at 0% and one at 100% are 50%', () => {
    const g = two(100, 0);
    expect(g.total.left).toBe(50);
    expect(g.row.figure).toBe('50% used');
  });

  it('leaves an unread account out of the total and says so, short', () => {
    const g = usageGlance(
      [acct('default'), acct('work', { name: 'Work' })],
      inv([line('default', { windows: [week(40)] }), line('work')]),
      { now: NOW }
    );
    expect(g.total.left).toBe(60);
    expect(g.total.counted).toBe(1);
    expect(g.total.notRead).toBe('1 account not read');
    expect(g.row.notRead).toBe('1 account not read');
    expect(g.total.weighting).toBeNull();
  });

  it('different plans: an average, said honestly; unknown plans the same', () => {
    const g = two(20, 60, ['max', 'pro']);
    expect(g.total.left).toBe(60);
    expect(g.total.weighting).toBe(
      'An average of each account’s % used. Plan sizes aren’t reported, so Max and Pro count the same here.'
    );
    expect(two(20, 60).total.weighting).toBe(
      'An average of each account’s % used: plan sizes aren’t reported, so each counts the same.'
    );
    expect(weightingOf(['Max', 'Max', 'Max'])).toBe('All 3 on Max, so each counts the same.');
    expect(weightingOf(['Max'])).toBeNull();
  });

  it('the bar turns amber only when the total is low, and quiet with nothing read', () => {
    expect(two(95, 95).total.tone).toBe('warning');
    expect(two(100, 100).total.tone).toBe('limited');
    const none = usageGlance([acct('default')], inv([line('default')]), { now: NOW });
    expect(none.total.tone).toBe('quiet');
  });
});

describe('who uses an account, and switching', () => {
  it('says who runs only on it and who used it this week', () => {
    const g = usageGlance(
      [acct('default', { name: 'sam@example.com' }), acct('work', { name: 'Work' })],
      inv([
        line('default', {
          windows: [week(20)],
          spent: [
            { agentId: 'f', name: 'Finance', turns: 2, tokens: 250_000 },
            { agentId: 'c', name: 'Chief', turns: 9, tokens: 750_000 },
            { agentId: 'f', name: 'Finance', routine: 'Monday', turns: 1, tokens: 600_000 },
          ],
        }),
        line('work', { windows: [week(40)] }),
      ]),
      { now: NOW, pins: [{ engine: 'claude', account: 'work', name: 'Riley' }] }
    );
    expect(g.keys[0].usedBy).toEqual(['Finance', 'Chief']);
    expect(usersLine(g.keys[0])).toBe('Used by Finance and Chief this week');
    expect(usersLine(g.keys[1])).toBe('Only Riley runs here');
    // A row's short line: two names whole, three or more as the first and a count.
    expect(usersLine(g.keys[0], { short: true })).toBe('Used by Finance and Chief this week');
    const many = { pinnedBy: [], usedBy: ['A', 'B', 'C', 'D'] };
    expect(usersLine(many, { short: true })).toBe('Used by A and 3 more this week');
    expect(usersLine(many)).toBe('Used by A, B, C and 1 more this week');
  });

  it('lists each agent of an engine with two accounts and what it runs on', () => {
    const g = usageGlance(
      [acct('default', { name: 'sam@example.com' }), acct('work', { name: 'Work' })],
      inv([line('default', { windows: [week(20)] }), line('work', { windows: [week(40)] })]),
      { now: NOW }
    );
    const rows = runsOnRows(g, [
      { id: 'r', name: 'Riley', engine: 'claude', account: 'work' },
      { id: 'c', name: 'Chief', engine: 'claude' },
      { id: 'x', name: 'Coder', engine: 'codex' },
      { id: 'g', name: 'Gone', engine: 'claude', account: 'removed' },
    ]);
    expect(rows.map((r) => [r.name, r.current, r.currentLabel])).toEqual([
      ['Riley', 'work', 'Work'],
      ['Chief', '', 'Any account'],
      ['Gone', '', 'Any account'],
    ]);
    expect(rows[0].choices.map((c) => c.label)).toEqual(['Any account', 'sam@example.com', 'Work']);
  });
});

describe('totalWords', () => {
  const session = (used: number, resetsIn: number) => ({
    kind: 'five_hour',
    usedPercent: used,
    resetsAt: NOW + resetsIn,
    limited: false,
    observedAt: NOW - 60_000,
  });

  it('says the total and the refill it counts, never a sooner limit it doesn’t', () => {
    const g = usageGlance(
      [acct('default', { name: 'sam@example.com' }), acct('work', { name: 'Work' })],
      inv([
        line('default', { windows: [week(56, 50 * H), session(80, 1 * H)] }),
        line('work', { windows: [week(0, 146 * H)] }),
      ]),
      { now: NOW }
    );
    const w = totalWords(g);
    expect(w.eyebrow).toBe('All accounts');
    expect(w.figure).toBe('28% used');
    expect(w.across).toBe('across 2 accounts');
    // The week the total counts, not the 5-hour limit an hour away.
    expect(w.refill).toMatch(/^Next refill in 2d 2h · sam@example\.com, /);
    expect(w.known).toBe(true);
  });

  it('nothing read: the quiet line, no figure, no refill', () => {
    const g = usageGlance([acct('default')], inv([line('default')]), { now: NOW });
    const w = totalWords(g);
    expect(w.known).toBe(false);
    expect(w.across).toBeNull();
    expect(w.eyebrow).toBeNull();
    expect(w.figure).toBe(g.headline);
  });
});

describe('glanceUsed (the glance, said as what is used)', () => {
  const total = (left: number | null, extra: Partial<UsageTotal> = {}): UsageTotal => ({
    left,
    used: left === null ? null : 100 - left,
    figure: left === null ? 'Not read yet' : `${100 - left}% used`,
    across: left === null ? '' : 'this week',
    unread: null,
    notRead: null,
    weighting: null,
    tone: 'calm',
    counted: left === null ? 0 : 1,
    refill: left === null ? null : { in: '6d 2h', at: 'Mon 9:00 AM', account: 'Work' },
    segments: [],
    ...extra,
  });
  const row = (figure: string, refill: string | null = 'Refills in 6d 2h') => ({
    figure,
    refill,
    count: null,
    notRead: null,
    needsYou: false,
  });

  it('92% left is 8% used: a short fill, ordinary ink, the countdown shortened', () => {
    const u = glanceUsed({ total: total(92), tone: 'calm', row: row('92% left this week') });
    expect(u.used).toBe(8);
    expect(u.line).toBe('8% used · refills in 6d');
    expect(u.detail).toBe('8% used this week · refills in 6d 2h');
    expect(u.tone).toBe('calm');
  });

  it('says each thing once: never "2 accounts" after "across 2 accounts"', () => {
    const u = glanceUsed({
      total: total(46, {
        counted: 2,
        across: 'across 2 accounts',
        refill: { in: '3d 18h', at: 'Fri', account: 'Work' },
      }),
      tone: 'calm',
      row: {
        ...row('54% used', 'Refills in 3d 18h'),
        count: '2 accounts',
        notRead: '1 account not read yet',
      },
    });
    expect(u.detail).toBe(
      '54% used across 2 accounts · 1 account not read yet · refills in 3d 18h'
    );
    // No phrase of two or more words appears twice.
    const words = u.detail.toLowerCase().replace(/[·.]/g, ' ').split(/\s+/).filter(Boolean);
    const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('takes the warning role from 80% used', () => {
    expect(glanceUsed({ total: total(21), tone: 'calm', row: row('x') }).tone).toBe('calm');
    expect(glanceUsed({ total: total(20), tone: 'calm', row: row('x') }).tone).toBe('high');
  });

  it('out everywhere is a full bar and the row’s own words, the refill said once', () => {
    const u = glanceUsed({
      total: total(0),
      tone: 'limited',
      row: row('Out until Sat 10:00 AM', 'Refills Sat 10:00 AM'),
    });
    expect(u.used).toBe(100);
    expect(u.line).toBe('Out until Sat 10:00 AM');
    expect(u.detail).toBe('Out until Sat 10:00 AM');
    expect(u.tone).toBe('out');
  });

  it('nothing read is no number and no bar', () => {
    const u = glanceUsed({ total: total(null), tone: 'calm', row: row('Not read yet', null) });
    expect(u.used).toBeNull();
    expect(u.line).toBe('Not read yet');
    expect(u.tone).toBe('quiet');
  });

  it('shortCountdown keeps the largest unit', () => {
    expect(shortCountdown('6d 2h')).toBe('6d');
    expect(shortCountdown('4h 59m')).toBe('4h');
    expect(shortCountdown('12m')).toBe('12m');
  });
});

describe('every usage surface says what is used', () => {
  it('usedFigure: "N% used", and at 100% "Out until <refill>"', () => {
    expect(usedFigure(38)).toBe('38% used');
    expect(usedFigure(100, 'Sat 10:00 AM')).toBe('Out until Sat 10:00 AM');
    expect(usedFigure(100)).toBe('Out of usage');
  });

  it('usedTone: the warning role from 80% used, limited at 100, quiet unread', () => {
    expect(usedTone(null)).toBe('quiet');
    expect(usedTone(79)).toBe('calm');
    expect(usedTone(80)).toBe('warning');
    expect(usedTone(100)).toBe('limited');
  });

  it('an account and its limits fill with use, the pace marker at the even pace used', () => {
    const g = usageGlance([acct('default')], inv([line('default', { windows: [week(62)] })]), {
      now: NOW,
    });
    const k = g.keys[0];
    expect(k.used).toBe(62);
    expect(k.figure).toBe('62% used');
    const l = k.limits[0];
    expect(l.used).toBe(62);
    expect(l.figure).toBe('62% used');
    expect(l.evenUsed).toBe(100 - (l.evenLeft as number));
    expect(g.total.used).toBe(62);
    expect(g.total.figure).toBe('62% used');
  });

  it('a limit used up says until when; 80% takes the warning role', () => {
    const up = usageGlance([acct('default')], inv([line('default', { windows: [week(100)] })]), {
      now: NOW,
    });
    expect(up.keys[0].limits[0].figure).toMatch(/^Out until /);
    expect(up.keys[0].limits[0].tone).toBe('limited');
    const high = usageGlance([acct('default')], inv([line('default', { windows: [week(80)] })]), {
      now: NOW,
    });
    expect(high.keys[0].limits[0].tone).toBe('warning');
    expect(high.total.tone).toBe('warning');
  });
});

describe('accountDisplayName', () => {
  it('leads with the email when the name was made up by the app', () => {
    expect(accountDisplayName('Account 2', 'julian@example.com')).toBe('julian@example.com');
    expect(accountDisplayName('', 'julian@example.com')).toBe('julian@example.com');
  });
  it('keeps a name the user chose, and a made-up one with no email', () => {
    expect(accountDisplayName('Work', 'julian@example.com')).toBe('Work');
    expect(accountDisplayName('Account 2', null)).toBe('Account 2');
  });
});
