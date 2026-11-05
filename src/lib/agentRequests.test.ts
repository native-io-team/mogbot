import { describe, expect, it } from 'vitest';
import {
  groupLine,
  groupRequests,
  requestsCounts,
  requestsDetail,
  requestsTitle,
} from './agentRequests';
import type { Agent, AgentMessage } from './agents';

const agent = (id: string, name: string, pendingApprovals = 0): Agent =>
  ({
    id,
    name,
    color: 'teal',
    pendingApprovals,
    status: { state: 'idle', activity: null, since: null },
  }) as unknown as Agent;

let n = 0;
const card = (
  agentId: string,
  over: Partial<NonNullable<AgentMessage['approval']>> = {}
): AgentMessage =>
  ({
    id: `m${++n}`,
    agentId,
    ts: n,
    kind: 'approval',
    text: '',
    approval: {
      requestId: `r${n}`,
      title: 'Run a command',
      detail: 'npm test',
      status: 'pending',
      ...over,
    },
  }) as AgentMessage;

const login = (agentId: string, name: string, status: 'pending' | 'allowed' = 'pending') =>
  card(agentId, {
    title: `Secure input · ${name}`,
    status,
    secret: {
      name,
      purpose: 'x',
      kind: 'token',
      fields: [{ label: 'Value', env: name.toUpperCase() }],
      reference: `secret:${agentId}/${name}`,
    } as never,
  });

describe('groupRequests', () => {
  it('counts sixteen imported agents and their logins, in name order', () => {
    const askers = Array.from({ length: 16 }, (_, i) => agent(`a${i}`, `Agent ${15 - i}`, 0));
    const messages: Record<string, AgentMessage[]> = {};
    let total = 0;
    askers.forEach((a, i) => {
      const k = (i % 4) + 1;
      total += k;
      messages[a.id] = Array.from({ length: k }, (_, j) => login(a.id, `key_${j}`));
      (a as { pendingApprovals: number }).pendingApprovals = k;
    });
    const s = groupRequests(askers, messages, new Set());
    expect(s.agents).toBe(16);
    expect(s.requests).toBe(total);
    expect(s.logins).toBe(total);
    expect(s.groups.map((g) => g.agent.name)).toEqual(
      [...s.groups.map((g) => g.agent.name)].sort((a, b) => a.localeCompare(b))
    );
    expect(requestsTitle(s)).toBe('16 agents need your OK');
    expect(requestsDetail(s)).toBe(`${total} logins to add`);
    expect(requestsCounts(s)).toBe(`16 agents · ${total} logins`);
  });

  it('leaves out agents whose lines have not loaded, and cards already in this chat', () => {
    const a = agent('a', 'Lead Gen', 1);
    const b = agent('b', 'Finance', 1);
    const shown = card('a');
    const s = groupRequests([a, b], { a: [shown] }, new Set([shown.approval!.requestId]));
    expect(s.groups).toEqual([]);
    expect(s.requests).toBe(0);
  });

  it('counts pending cards older than the loaded lines from the registry, never more', () => {
    const a = agent('a', 'Slack Watch', 5);
    const s = groupRequests(
      [a],
      { a: [login('a', 'slack_bot_token'), login('a', 'notion')] },
      new Set()
    );
    expect(s.groups[0].older).toBe(3);
    expect(s.requests).toBe(5);
    // Logins are counted only from cards that loaded.
    expect(s.logins).toBe(2);
    expect(requestsDetail(s)).toBe('5 requests, 2 of them logins');
    expect(groupLine(s.groups[0])).toBe('5 requests, 2 of them logins');
  });

  it('keeps cards answered while open, but no longer counts them', () => {
    const a = agent('a', 'Finance', 0);
    const done = login('a', 'stripe_key', 'allowed');
    const s = groupRequests([a], { a: [done] }, new Set(), new Set([done.id]));
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].cards).toEqual([done]);
    expect(s.requests).toBe(0);
    expect(s.agents).toBe(0);
    expect(groupLine(s.groups[0])).toBe('Answered');
    expect(requestsTitle(s)).toBe('Nothing else needs your OK');
  });

  it('drops an answered card that was not kept', () => {
    const a = agent('a', 'Finance', 0);
    const s = groupRequests([a], { a: [login('a', 'stripe_key', 'allowed')] }, new Set());
    expect(s.groups).toEqual([]);
  });
});

describe('the words', () => {
  it('names one or two agents, counts past that', () => {
    const one = groupRequests([agent('a', 'Lead Gen', 1)], { a: [card('a')] }, new Set());
    expect(requestsTitle(one)).toBe('Lead Gen needs your OK');
    expect(requestsDetail(one)).toBe('1 request');
    expect(requestsCounts(one)).toBe('1 agent · 1 request');
    expect(groupLine(one.groups[0])).toBe('Run a command');

    const two = groupRequests(
      [agent('l', 'Lead Gen', 1), agent('f', 'Finance', 1)],
      { l: [card('l')], f: [login('f', 'stripe_key')] },
      new Set()
    );
    expect(requestsTitle(two)).toBe('Finance and Lead Gen need your OK');
    expect(requestsDetail(two)).toBe('2 requests, 1 of them a login');
    expect(groupLine(two.groups[0])).toBe('1 login: Stripe key');
  });

  it('lists two login names, then an ellipsis', () => {
    const s = groupRequests(
      [agent('a', 'Slack Watch', 3)],
      { a: [login('a', 'slack_bot_token'), login('a', 'slack_user_token'), login('a', 'notion')] },
      new Set()
    );
    expect(groupLine(s.groups[0])).toBe('3 logins: Slack bot token, Slack user token…');
    expect(requestsDetail(s)).toBe('3 logins to add');
  });

  it('says a session question in its own words', () => {
    const s = groupRequests(
      [agent('a', 'Acme Site', 1)],
      {
        a: [
          card('a', {
            prompt: { kind: 'trust', question: 'Let Claude Code work in demo-site?' } as never,
          }),
        ],
      },
      new Set()
    );
    expect(groupLine(s.groups[0])).toBe('Let Claude Code work in demo-site?');
  });
});

describe('login cards in the requests bar', () => {
  it('counts a login card as a login and names its app', () => {
    const a = agent('rec', 'Recruiter');
    const gmail = card('rec', {
      title: 'Recruiter needs your Gmail',
      login: { service: 'gmail', title: 'Gmail', why: 'x', abilities: [], options: [] } as never,
    });
    const linear = card('rec', {
      title: 'Recruiter needs your Linear',
      login: { service: 'linear', title: 'Linear', why: 'x', abilities: [], options: [] } as never,
    });
    const s = groupRequests([a], { rec: [gmail, linear] }, new Set());
    expect(s.logins).toBe(2);
    expect(requestsDetail(s)).toBe('2 logins to add');
    expect(groupLine(s.groups[0])).toBe('2 logins: Gmail, Linear');
  });
});
