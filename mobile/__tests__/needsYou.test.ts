/**
 * The Needs you feed (lib/needsYou.ts): every card across every agent,
 * most urgent first and newest first within, answered ones gone; and which
 * rows are answered in place (only what fits whole).
 */

import type { Agent, AgentMessage, Approval } from '@shipstudio/companion-protocol';
import { GATE_ALLOW, GATE_DENY } from '@shipstudio/companion-protocol';
import { feedItems, fitsWhole, keepCard, rowAction } from '../src/lib/needsYou';
import { agent, msg } from './helpers';

const a = (id: string, over: Partial<Agent> = {}) =>
  agent({ id, name: id, isMain: false, pinned: false, hidden: false, lastActivityAt: 0, ...over });

const approval = (requestId: string, over: Partial<Approval> = {}): Approval =>
  ({ requestId, title: 'Run a command', detail: 'ls', status: 'pending', ...over }) as Approval;

const ask = (id: string, agentId: string, ts: number, over: Partial<Approval> = {}) =>
  msg(id, ts, { agentId, kind: 'approval', text: '', approval: approval(id, over) });

const changes = (id: string, agentId: string, ts: number, copyId: string, fileCount = 2) =>
  msg(id, ts, {
    agentId,
    kind: 'changes',
    text: '',
    changes: {
      project: 'acme-site',
      from: 'a',
      to: 'b',
      files: [],
      fileCount,
      added: 3,
      removed: 1,
      copy: { id: copyId, path: '/tmp/c', branch: 'task' },
    },
  } as Partial<AgentMessage>);

const copy = (id: string) =>
  ({
    id,
    path: '/tmp/c',
    branch: 'task',
    project: '/p',
    base: 'a',
    createdAt: 0,
    deps: false,
  }) as Agent['copy'];

const keys = (items: { key: string }[]) => items.map((i) => i.key);

describe('the feed', () => {
  it('lists every waiting card across agents, newest first', () => {
    const agents = [a('design', { pendingApprovals: 1 }), a('site', { pendingApprovals: 2 })];
    const chats = {
      design: { messages: [ask('d1', 'design', 20)] },
      site: { messages: [ask('s1', 'site', 5), ask('s2', 'site', 30)] },
    };
    expect(keys(feedItems(agents, chats, null))).toEqual(['ask:s2', 'ask:d1', 'ask:s1']);
  });

  it('puts what blocks an agent before changes to keep, setup and the Mac’s own', () => {
    const agents = [
      a('chief', { isMain: true }),
      a('site', { status: { state: 'idle', activity: null, since: null }, copy: copy('c1') }),
      a('ops', {
        failure: { kind: 'other' },
        status: { state: 'idle', activity: null, since: null },
        lastActivityAt: 90,
      }),
      a('imp', { pendingApprovals: 1 }),
      a('fin', { pendingApprovals: 1 }),
    ];
    const chats = {
      site: { messages: [changes('ch', 'site', 80, 'c1')] },
      imp: { messages: [ask('r', 'imp', 99, { connector: { kind: 'review' } as never })] },
      fin: { messages: [ask('f1', 'fin', 10)] },
    };
    const setup = {
      id: 's',
      source: 'Grok Bot',
      steps: [{ id: 'x', state: 'open' }],
      done: 0,
      total: 1,
      complete: false,
    } as never;
    expect(keys(feedItems(agents, chats, setup))).toEqual([
      'ask:f1',
      'stuck:ops',
      'keep:ch',
      'setup',
      'mac:r',
    ]);
  });

  it('drops a card once it is answered, and leaves hidden agents out', () => {
    const agents = [a('x', { pendingApprovals: 1 }), a('h', { hidden: true, pendingApprovals: 1 })];
    const answered = { ...ask('x1', 'x', 1), approval: approval('x1', { status: 'allowed' }) };
    const items = feedItems(
      agents,
      { x: { messages: [answered] }, h: { messages: [ask('h1', 'h', 2)] } },
      null
    );
    // Counted on the Mac, not in the chat any more: the agent, until its chat says otherwise.
    expect(keys(items)).toEqual(['stuck:x']);
    expect(keys(feedItems([a('x')], { x: { messages: [answered] } }, null))).toEqual([]);
  });

  it('lets a review card be answered here when this Mac allows it', () => {
    const chats = {
      x: { messages: [ask('r', 'x', 1, { connector: { kind: 'review' } as never })] },
    };
    expect(feedItems([a('x', { pendingApprovals: 1 })], chats, null, true)[0].kind).toBe('ask');
  });

  it('asks to keep a copy only once the turn is over and it changed something', () => {
    const idle = { state: 'idle', activity: null, since: null } as const;
    const working = { state: 'working', activity: null, since: 1 } as const;
    const chats = { s: { messages: [changes('ch', 's', 1, 'c1')] } };
    expect(keys(feedItems([a('s', { status: idle, copy: copy('c1') })], chats, null))).toEqual([
      'keep:ch',
    ]);
    expect(feedItems([a('s', { status: working, copy: copy('c1') })], chats, null)).toEqual([]);
    // A card from an older copy isn't this one's.
    expect(feedItems([a('s', { status: idle, copy: copy('c2') })], chats, null)).toEqual([]);
    const empty = { s: { messages: [changes('ch', 's', 1, 'c1', 0)] } };
    expect(keepCard(a('s', { copy: copy('c1') }), empty.s.messages)).toBeUndefined();
  });

  it('never counts a usage limit as needing you', () => {
    const limited = a('x', {
      failure: { kind: 'usage_limit' },
      status: { state: 'idle', activity: null, since: null },
    });
    expect(feedItems([limited], {}, null)).toEqual([]);
  });
});

describe('answering a row', () => {
  const row = (m: AgentMessage) =>
    rowAction({ key: 'k', kind: 'ask', agentId: 'x', messageId: m.id, ts: 0 }, m);

  it('answers a plain short request in place', () => {
    const m = ask('a', 'x', 1);
    expect(row(m)).toEqual({ kind: 'answer', allow: 'Allow', deny: 'Deny' });
    expect(fitsWhole(m)).toBe(true);
  });

  it('uses a card’s own words', () => {
    const gate = ask('g', 'x', 1, { gate: { routine: 'R', done: 1, total: 2 } as never });
    expect(row(gate)).toEqual({ kind: 'answer', allow: GATE_ALLOW, deny: GATE_DENY });
  });

  it('opens keys, logins and questions where they are answered', () => {
    expect(row(ask('s', 'x', 1, { secret: { name: 'STRIPE_KEY' } as never }))).toMatchObject({
      kind: 'open',
      label: 'Enter key',
    });
    expect(row(ask('l', 'x', 1, { login: { service: 'gmail' } as never }))).toMatchObject({
      kind: 'open',
      label: 'Sign in',
    });
  });

  it('opens a long request in full before it can be allowed', () => {
    const long = ask('l', 'x', 1, {
      detail: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'),
    });
    expect(fitsWhole(long)).toBe(false);
    const plan = ask('p', 'x', 1, {
      plan: {
        actions: Array.from({ length: 5 }, () => ({ kind: 'send', target: 't', summary: 'Send' })),
      } as never,
    });
    expect(fitsWhole(plan)).toBe(false);
  });

  it('opens what isn’t a question in its chat', () => {
    expect(rowAction({ key: 'k', kind: 'keep', agentId: 'x', ts: 0 }, undefined)).toEqual({
      kind: 'open',
      label: 'Review changes',
    });
    expect(rowAction({ key: 'k', kind: 'stuck', agentId: 'x', ts: 0 }, undefined)).toEqual({
      kind: 'open',
      label: 'Open chat',
    });
  });
});
