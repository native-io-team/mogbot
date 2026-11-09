import { describe, expect, it } from 'vitest';
import type { UsageAccount, UsageAccountLine, UsageInventory } from './model';
import { changeLines, relativeIn, usageGlance } from './usageGlance';

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
    expect(g.summary).toMatch(/^2 accounts · resets /);
    expect(g.keys[0].detail).toContain('Max plan');
    expect(g.low).toBeNull();
  });

  it('never fills an account it has no reading of', () => {
    const g = usageGlance([acct('default')], inv([line('default')]), { now: NOW });
    expect(g.keys[0].left).toBeNull();
    expect(g.keys[0].tone).toBe('quiet');
    expect(g.headline).toBe('No usage reading yet');
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
    expect(p.stateLabel).toBe('Same account as sam@example.com');
    expect(p.left).toBeNull();
    expect(p.limits).toEqual([]);
    expect(p.canUse).toBe(false);
    expect(p.fix?.action).toBe('sign_in_other');
    // Counted once.
    expect(g.summary).toMatch(/^1 account · /);
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
    expect(g.headline).toMatch(/^Out of usage until /);
    expect(g.tone).toBe('limited');
    expect(g.keys[0].stateLabel).toMatch(/^Out of usage until /);
    expect(g.low?.waitUntil).toMatch(/^Wait until /);
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
    expect(g.headline).toMatch(/^Runs out ~.*, 3 days before reset$/);
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
    expect(work.detail).toEqual(['Max plan', 'sam@example.com', 'this Mac’s own sign-in']);
    // The plan isn't said twice when it is the name.
    expect(named({ name: 'This Mac', plan: 'max' }).detail).toEqual(['this Mac’s own sign-in']);
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
    expect(g.keys[1].stateLabel).toBe('Same account as sam@example.com');
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
    expect(g.headline).toBe('Runs out in about 50 minutes, 3 days before reset');
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
    expect(g.nudge?.text).toBe('62% of Work’s week resets in 9 h');
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
    expect(g.nudge?.text).toBe('62% of sam@example.com’s week resets in 9 h');
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
    expect(lines[0].title).toBe('Weekly 68% → 33% left');
    expect(lines[0].elsewhere).toMatch(/^Nothing these agents ran explains this/);
    expect(lines[1].runs).toEqual(['Riley: Morning brief · 3 turns · 1.2M tokens']);
    expect(lines[1].elsewhere).toBeNull();
  });

  it('says when, relative and short', () => {
    expect(relativeIn(NOW + 40 * 60_000, NOW)).toBe('in 40 min');
    expect(relativeIn(NOW + 9 * H, NOW)).toBe('in 9 h');
    expect(relativeIn(NOW + 5 * 24 * H, NOW)).toBe('in 5 days');
  });
});
