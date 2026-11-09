import { describe, expect, it } from 'vitest';
import type { UsageAccount, UsageAccountLine, UsageInventory } from './model';
import {
  inUseOf,
  movedIds,
  pinnedLine,
  roomOf,
  switcherView,
  usedFirst,
  workingLine,
} from './accountSwitcher';
import * as real from './fixtures.gen';

// A Thursday, noon local.
const NOW = new Date(2026, 10, 5, 12, 0).getTime();
const HOUR = 3_600_000;

const acct = (over: Partial<UsageAccount> & Pick<UsageAccount, 'id' | 'name'>): UsageAccount => ({
  engine: 'claude',
  thisMac: over.id === 'default',
  signedIn: true,
  out: false,
  named: over.id !== 'default',
  ...over,
});

const line = (id: string, five: number, week: number): UsageAccountLine => ({
  engine: 'claude',
  id,
  name: id,
  thisMac: id === 'default',
  signedIn: true,
  out: false,
  next: false,
  windows: [
    {
      kind: 'five_hour',
      usedPercent: five,
      resetsAt: NOW + 2 * HOUR,
      limited: false,
      observedAt: NOW - 60_000,
    },
    {
      kind: 'seven_day',
      usedPercent: week,
      resetsAt: NOW + 50 * HOUR,
      limited: false,
      observedAt: NOW - 60_000,
    },
  ],
  learned: [],
});

const inventory = (accounts: UsageAccountLine[]): UsageInventory =>
  ({ ...(real.agentsUsagePlan as unknown as UsageInventory), accounts }) as UsageInventory;

describe('which account is working', () => {
  const mac = acct({
    id: 'default',
    name: 'sam@example.com',
    email: 'sam@example.com',
    plan: 'Max',
  });
  const work = acct({ id: 'w', name: 'Work', email: 'me@work.example' });
  const off = acct({ id: 'o', name: 'Old', signedIn: false });

  it('is the first signed-in account that is not out, as the Mac picks it', () => {
    expect(inUseOf([mac, work])?.id).toBe('default');
    expect(inUseOf([{ ...mac, out: true }, work])?.id).toBe('w');
    // One usable account always runs: the engine says whether it can.
    expect(inUseOf([{ ...mac, out: true }, off])?.id).toBe('default');
    expect(inUseOf([off, work])?.id).toBe('w');
  });

  it('lists every account in order with its room, who it is and what can be done', () => {
    const [claude] = switcherView([mac, work, off], inventory([line('default', 38, 12)]), {
      now: NOW,
      pins: [{ engine: 'claude', account: 'w', name: 'Riley' }],
    });
    expect(claude.label).toBe('Claude Code');
    expect(claude.rows.map((r) => [r.name, r.state, r.canUse])).toEqual([
      ['sam@example.com', 'In use', false],
      ['Work', 'Ready', true],
      ['Old', 'Not signed in', false],
    ]);
    // Never the email twice: it's the name of the unnamed one.
    expect(claude.rows[0].detail).toEqual(['Max plan', 'this Mac’s own sign-in']);
    expect(claude.rows[1].detail).toEqual(['me@work.example']);
    expect(claude.rows[0].room.map((r) => [r.label, r.left])).toEqual([
      ['5-hour', 62],
      ['Weekly', 88],
    ]);
    expect(claude.rows[0].room[0].resets).toMatch(/^resets /);
    // No reading: no figure, never a full bar.
    expect(claude.rows[1].room).toEqual([]);
    expect(claude.rows[1].pinnedBy).toEqual(['Riley']);
  });

  it('swapping is the order: whichever is first and usable is in use', () => {
    const ids = usedFirst(['default', 'w', 'o'], 'w');
    expect(ids).toEqual(['w', 'default', 'o']);
    const byId = { default: mac, w: work, o: off } as Record<string, UsageAccount>;
    const [claude] = switcherView(
      ids.map((i) => byId[i]),
      null,
      { now: NOW }
    );
    expect(claude.rows.find((r) => r.inUse)?.name).toBe('Work');
    expect(movedIds(ids, 0, 1)).toEqual(['default', 'w', 'o']);
    expect(movedIds(ids, 0, -1)).toBeNull();
  });

  it('the sidebar row says the account and its tighter room', () => {
    const [claude] = switcherView([mac, work], inventory([line('default', 38, 95)]), { now: NOW });
    const row = workingLine(claude)!;
    expect(row.name).toBe('sam@example.com');
    expect(row.room).toBe('5% left');
    expect(row.tone).toBe('warning');
    expect(row.several).toBe(true);
    expect(row.detail).toMatch(
      /^Agents on Claude Code are using sam@example.com\. 5% of its weekly/
    );

    const out = switcherView(
      [
        { ...mac, out: true, limit: { at: NOW - HOUR, resetsAt: NOW + 3 * HOUR } },
        { ...work, out: true },
      ],
      null,
      { now: NOW }
    )[0];
    expect(out.allOut).toBe(true);
    expect(workingLine(out)?.room).toBe('Out of usage');

    const unread = switcherView([mac], null, { now: NOW })[0];
    expect(workingLine(unread)?.room).toBeUndefined();
    expect(workingLine(unread)?.several).toBe(false);
  });

  it('a used-up or past window is said as it is', () => {
    expect(
      roomOf([{ kind: 'five_hour', limited: true, observedAt: NOW, resetsAt: NOW + HOUR }], NOW)[0]
    ).toMatchObject({ left: 0, tone: 'limited' });
    expect(
      roomOf(
        [
          {
            kind: 'five_hour',
            usedPercent: 40,
            limited: false,
            observedAt: NOW,
            resetsAt: NOW - 1,
          },
        ],
        NOW
      )
    ).toEqual([]);
  });

  it('names who is set to one account', () => {
    expect(pinnedLine([])).toBeNull();
    expect(pinnedLine(['Riley'])).toBe('Riley runs only on this one');
    expect(pinnedLine(['Riley', 'Max', 'Ana'])).toBe('Riley, Max and Ana run only on this one');
  });

  it('reads what the Mac actually serves', () => {
    const view = switcherView(real.agentsAccounts, null, { now: NOW });
    expect(view.map((e) => e.engine)).toEqual(['claude', 'codex']);
    expect(view[0].rows[0]).toMatchObject({ name: 'sam@example.com', named: false, inUse: true });
    expect(view[1].rows[0].state).toBe('Not signed in');
  });
});
