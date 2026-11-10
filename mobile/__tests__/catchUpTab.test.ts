/**
 * The Catch up tab (lib/catchUpTab.ts with lib/needsYou.ts): rows grouped by
 * agent in urgency order, answered ones gone, risky ones never answered in
 * place, what happened since the last visit from records only, and where
 * the app opens.
 */

import type { Agent, AgentMessage, Approval } from '@shipstudio/companion-protocol';
import {
  AWAY_MS,
  SETTLE_MS,
  fromLine,
  groupByAgent,
  headline,
  landingOnLaunch,
  landingOnReturn,
  settleLaunch,
  sinceItems,
  sinceTitle,
} from '../src/lib/catchUpTab';
import { answersInPlace, feedItems } from '../src/lib/needsYou';
import { agent, msg } from './helpers';

const a = (id: string, over: Partial<Agent> = {}) =>
  agent({ id, name: id, isMain: false, pinned: false, hidden: false, lastActivityAt: 0, ...over });

const approval = (requestId: string, over: Partial<Approval> = {}): Approval =>
  ({ requestId, title: 'Run a command', detail: 'ls', status: 'pending', ...over }) as Approval;

const ask = (id: string, agentId: string, ts: number, over: Partial<Approval> = {}) =>
  msg(id, ts, { agentId, kind: 'approval', text: '', approval: approval(id, over) });

describe('grouped by agent', () => {
  it('keeps the feed’s order: each agent where its most urgent row is', () => {
    const agents = [
      a('design', { pendingApprovals: 1 }),
      a('site', { pendingApprovals: 2 }),
      a('ops', { failure: { kind: 'other' }, lastActivityAt: 99 }),
    ];
    const chats = {
      design: { messages: [ask('d1', 'design', 20)] },
      site: { messages: [ask('s1', 'site', 5), ask('s2', 'site', 30)] },
    };
    const groups = groupByAgent(feedItems(agents, chats, null));
    expect(groups.map((g) => g.agentId)).toEqual(['site', 'design', 'ops']);
    expect(groups[0].items.map((i) => i.key)).toEqual(['ask:s2', 'ask:s1']);
  });

  it('an answered card leaves, and its agent with it once it has nothing left', () => {
    const agents = [a('site', { pendingApprovals: 1 }), a('design', { pendingApprovals: 1 })];
    const before = {
      site: { messages: [ask('s1', 'site', 5)] },
      design: { messages: [ask('d1', 'design', 9)] },
    };
    expect(groupByAgent(feedItems(agents, before, null))).toHaveLength(2);
    const after = {
      ...before,
      site: { messages: [ask('s1', 'site', 5, { status: 'allowed' })] },
    };
    const groups = groupByAgent(
      feedItems([a('site'), a('design', { pendingApprovals: 1 })], after, null)
    );
    expect(groups.map((g) => g.agentId)).toEqual(['design']);
  });

  it('says how many, in plain words', () => {
    expect(headline(0)).toBe('Nothing needs you');
    expect(headline(1)).toBe('1 thing needs you');
    expect(headline(3)).toBe('3 things need you');
    expect(fromLine(1)).toBeNull();
    expect(fromLine(2)).toBe('From 2 agents');
  });
});

describe('risk on a row', () => {
  it('answers in place only what the Mac marked low-risk and fits whole', () => {
    expect(answersInPlace(ask('m', 's', 1, { risk: 'low' }))).toBe(true);
    expect(answersInPlace(ask('m', 's', 1, { risk: 'high' }))).toBe(false);
    // Unclassified (an older Mac): opens in full first.
    expect(answersInPlace(ask('m', 's', 1))).toBe(false);
    expect(answersInPlace(ask('m', 's', 1, { risk: 'low', detail: 'x'.repeat(400) }))).toBe(
      false
    );
  });
});

describe('since you last caught up', () => {
  const result = (id: string, ts: number, resultId: string, title: string) =>
    msg(id, ts, {
      agentId: 'site',
      kind: 'agent',
      text: 'Here it is:',
      result: { id: resultId, version: 1, title, summary: 'All three pages\nmore' },
    } as Partial<AgentMessage>);

  it('lists results, routines and failures after the visit, newest first', () => {
    const chats = {
      site: {
        messages: [
          result('old', 5, 'r0', 'Before'),
          result('r1', 20, 'r1', 'Pricing page'),
          msg('c1', 30, {
            agentId: 'site',
            kind: 'check_in',
            text: 'Checked the inbox',
            checkIn: { dueAt: 30, late: false, repeats: true },
          }),
          msg('e1', 40, { agentId: 'site', kind: 'error', text: 'The build failed\nstack' }),
        ],
      },
    };
    const got = sinceItems([a('site')], chats, 10);
    expect(got.map((g) => g.key)).toEqual(['failed:e1', 'routine:c1', 'result:r1']);
    expect(got[2]).toMatchObject({ title: 'Shared “Pricing page”', line: 'All three pages' });
    expect(got[1]).toMatchObject({ title: 'Routine ran', line: 'Checked the inbox' });
    expect(got[0]).toMatchObject({ title: 'Didn’t finish', line: 'The build failed' });
  });

  it('shows one row per result, its newest version', () => {
    const chats = {
      site: { messages: [result('v1', 20, 'r1', 'Draft'), result('v2', 30, 'r1', 'Draft v2')] },
    };
    expect(sinceItems([a('site')], chats, 0).map((g) => g.key)).toEqual(['result:v2']);
  });

  it('unread replies are one row, only for agents with nothing else said and not waiting', () => {
    const agents = [
      a('quiet', { unread: 2, lastActivityAt: 50, preview: 'Done with the copy' }),
      a('asking', { unread: 1, lastActivityAt: 60 }),
      a('stale', { unread: 1, lastActivityAt: 5 }),
    ];
    const got = sinceItems(agents, {}, 10, new Set(['asking']));
    expect(got).toEqual([
      expect.objectContaining({
        key: 'replies:quiet',
        title: '2 new messages',
        line: 'Done with the copy',
      }),
    ]);
  });

  it('nothing from hidden agents, nothing invented without a chat', () => {
    expect(sinceItems([a('h', { hidden: true, unread: 3, lastActivityAt: 50 })], {}, 0)).toEqual(
      []
    );
    expect(sinceItems([a('x')], {}, 0)).toEqual([]);
  });

  it('names what it measured from', () => {
    expect(sinceTitle(123)).toBe('Since you last caught up');
    expect(sinceTitle(null)).toBe('Recently');
  });
});

describe('where the app opens', () => {
  it('at launch: Catch up when anything waits, else Agents', () => {
    expect(landingOnLaunch(2)).toBe('/catch-up');
    expect(landingOnLaunch(0)).toBe('/agents');
  });

  it('puts a stale launch right once, only while you haven’t moved', () => {
    const base = { landed: '/catch-up' as const, pathname: '/catch-up', sinceLaunchMs: 900 };
    expect(settleLaunch({ ...base, waiting: 0 })).toBe('/agents');
    expect(settleLaunch({ ...base, waiting: 1 })).toBeNull();
    expect(settleLaunch({ ...base, pathname: '/chat/site', waiting: 0 })).toBeNull();
    expect(settleLaunch({ ...base, sinceLaunchMs: SETTLE_MS + 1, waiting: 0 })).toBeNull();
    expect(
      settleLaunch({ landed: '/agents', pathname: '/agents', sinceLaunchMs: 500, waiting: 3 })
    ).toBe('/catch-up');
  });

  it('coming back after a while: Catch up when anything waits', () => {
    expect(landingOnReturn({ awayMs: AWAY_MS, pathname: '/agents', waiting: 1 })).toBe(
      '/catch-up'
    );
    expect(landingOnReturn({ awayMs: AWAY_MS, pathname: '/projects', waiting: 1 })).toBe(
      '/catch-up'
    );
    expect(landingOnReturn({ awayMs: AWAY_MS, pathname: '/catch-up', waiting: 1 })).toBeNull();
  });

  it('never yanks: not after a short break, never from a chat or a sheet', () => {
    expect(landingOnReturn({ awayMs: AWAY_MS - 1, pathname: '/agents', waiting: 4 })).toBeNull();
    expect(landingOnReturn({ awayMs: AWAY_MS * 9, pathname: '/chat/site', waiting: 4 })).toBeNull();
    expect(landingOnReturn({ awayMs: AWAY_MS * 9, pathname: '/request', waiting: 4 })).toBeNull();
  });

  it('nothing waiting: stays put, except an emptied Catch up hands you to Agents', () => {
    expect(landingOnReturn({ awayMs: AWAY_MS, pathname: '/projects', waiting: 0 })).toBeNull();
    expect(landingOnReturn({ awayMs: AWAY_MS, pathname: '/catch-up', waiting: 0 })).toBe(
      '/agents'
    );
  });
});
