/**
 * Catch up (lib/catchUp.ts): what's waiting, in order; Next and answering
 * move on; a card answered elsewhere drops out; new ones join the end; and
 * the done state.
 */

import type { Agent, AgentMessage, Approval } from '@shipstudio/companion-protocol';
import {
  advance,
  askAction,
  askState,
  buildItems,
  cardMessages,
  current,
  isDone,
  progressOf,
  startQueue,
  syncQueue,
} from '../src/lib/catchUp';
import { agent, msg } from './helpers';

const a = (id: string, over: Partial<Agent> = {}) =>
  agent({ id, name: id, isMain: false, pinned: false, hidden: false, lastActivityAt: 0, ...over });

const approval = (requestId: string, over: Partial<Approval> = {}): Approval =>
  ({ requestId, title: 'Run a command', detail: 'ls', status: 'pending', ...over }) as Approval;

const ask = (id: string, agentId: string, ts: number, over: Partial<Approval> = {}) =>
  msg(id, ts, { agentId, kind: 'approval', text: '', approval: approval(id, over) });

const keys = (items: { key: string }[]) => items.map((i) => i.key);

describe('the order', () => {
  it('goes through every request oldest first, then what is new to read', () => {
    const agents = [
      a('design', { pendingApprovals: 1, lastActivityAt: 50 }),
      a('site', { pendingApprovals: 2, lastActivityAt: 40 }),
      a('fin', { unread: 2, lastActivityAt: 30 }),
      a('ops', { unread: 1, lastActivityAt: 10 }),
      a('quiet'),
    ];
    const chats = {
      design: { messages: [ask('d1', 'design', 20)] },
      site: { messages: [ask('s1', 'site', 5), ask('s2', 'site', 30)] },
    };
    expect(keys(buildItems(agents, chats, null))).toEqual([
      'ask:s1',
      'ask:d1',
      'ask:s2',
      'reply:ops:10',
      'reply:fin:30',
    ]);
  });

  it('puts setting up your team first, and leaves hidden agents out', () => {
    const chief = a('chief', { isMain: true });
    const items = buildItems([chief, a('gone', { hidden: true, unread: 3 })], {}, {
      id: 's',
      source: 'Grok Bot',
      steps: [{ id: 'x', state: 'open' }],
      done: 0,
      total: 1,
      complete: false,
    } as never);
    expect(keys(items)).toEqual(['setup']);
  });

  it('shows an agent that needs you with nothing answerable here as a card to read', () => {
    const items = buildItems([a('x', { pendingApprovals: 1 })], {}, null);
    expect(items).toMatchObject([{ kind: 'reply', agentId: 'x' }]);
  });

  it('leaves a review card to the Mac unless this Mac lets the phone answer it', () => {
    const chats = {
      x: { messages: [ask('r', 'x', 1, { connector: { kind: 'review' } as never })] },
    };
    const agents = [a('x', { pendingApprovals: 1 })];
    expect(buildItems(agents, chats, null)[0].kind).toBe('reply');
    expect(buildItems(agents, chats, null, true)[0].key).toBe('ask:r');
  });
});

describe('moving through', () => {
  const items = buildItems(
    [a('x', { pendingApprovals: 1 }), a('y', { unread: 1, lastActivityAt: 9 })],
    { x: { messages: [ask('c1', 'x', 1)] } },
    null
  );

  it('counts "1 of 2", then on, then done', () => {
    let q = startQueue(items);
    expect(progressOf(q)).toEqual({ n: 1, of: 2 });
    expect(current(q)?.key).toBe('ask:c1');
    q = advance(q);
    expect(progressOf(q)).toEqual({ n: 2, of: 2 });
    q = advance(q);
    expect(isDone(q)).toBe(true);
    expect(current(q)).toBeNull();
    // Past the end stays at the end.
    expect(advance(q).at).toBe(2);
  });

  it('is done from the start when nothing is waiting', () => {
    expect(isDone(startQueue([]))).toBe(true);
  });
});

describe('keeping up with the Mac', () => {
  const x = a('x', { pendingApprovals: 2 });
  const chats = { x: { messages: [ask('c1', 'x', 1), ask('c2', 'x', 2), ask('c3', 'x', 3)] } };
  const start = startQueue(buildItems([x], chats, null));

  it('drops a card ahead of you that was answered on the desk', () => {
    const fresh = buildItems(
      [x],
      { x: { messages: [ask('c1', 'x', 1), ask('c3', 'x', 3)] } },
      null
    );
    const q = syncQueue(start, fresh);
    expect(keys(q.items)).toEqual(['ask:c1', 'ask:c3']);
    expect(progressOf(q)).toEqual({ n: 1, of: 2 });
  });

  it('keeps the card in front of you, so the screen can say what became of it', () => {
    const fresh = buildItems(
      [x],
      { x: { messages: [ask('c2', 'x', 2), ask('c3', 'x', 3)] } },
      null
    );
    const q = syncQueue(start, fresh);
    expect(current(q)?.key).toBe('ask:c1');
  });

  it('keeps what you passed, so the count does not jump', () => {
    const answered = a('x', { pendingApprovals: 0 });
    const q = syncQueue(advance(start), buildItems([answered], { x: { messages: [] } }, null));
    expect(keys(q.items)).toEqual(['ask:c1', 'ask:c2']);
    expect(q.at).toBe(1);
  });

  it('adds a request that arrives while you catch up at the end', () => {
    const more = { x: { messages: [...chats.x.messages, ask('c4', 'x', 0)] } };
    const q = syncQueue(start, buildItems([x], more, null));
    expect(keys(q.items)).toEqual(['ask:c1', 'ask:c2', 'ask:c3', 'ask:c4']);
  });

  it('brings a new arrival up after "All caught up"', () => {
    let q = advance(advance(advance(start)));
    expect(isDone(q)).toBe(true);
    const more = { x: { messages: [...chats.x.messages, ask('c4', 'x', 9)] } };
    q = syncQueue(q, buildItems([x], more, null));
    expect(current(q)?.key).toBe('ask:c4');
  });

  it('keeps one reply card per agent ahead of you', () => {
    const y1 = a('y', { unread: 1, lastActivityAt: 1 });
    const y2 = a('y', { unread: 2, lastActivityAt: 2 });
    const q0 = startQueue(buildItems([y1], {}, null));
    expect(keys(syncQueue(q0, buildItems([y2], {}, null)).items)).toEqual(['reply:y:1']);
  });

  it('returns the same queue when nothing changed', () => {
    expect(syncQueue(start, buildItems([x], chats, null))).toBe(start);
  });
});

describe('a card', () => {
  it('says what became of its request', () => {
    const item = { key: 'ask:c', kind: 'ask' as const, agentId: 'x', messageId: 'c', ts: 0 };
    expect(askState(item, [ask('c', 'x', 0)])).toBe('pending');
    expect(askState(item, [ask('c', 'x', 0, { status: 'allowed' })])).toBe('answered');
    expect(askState(item, [ask('c', 'x', 0, { status: 'expired' })])).toBe('expired');
    expect(askState(item, [])).toBe('gone');
  });

  it('shows what led to a request, since you last spoke', () => {
    const messages: AgentMessage[] = [
      msg('old', 1),
      msg('you', 2, { kind: 'user' }),
      msg('a1', 3),
      msg('a2', 4),
      ask('c', 'x', 5),
    ];
    const item = { key: 'ask:c', kind: 'ask' as const, agentId: 'x', messageId: 'c', ts: 5 };
    expect(cardMessages(item, messages).map((m) => m.id)).toEqual(['a1', 'a2']);
  });

  it('shows as many replies as were new, at most three', () => {
    const messages = [msg('a1', 1), msg('a2', 2), msg('a3', 3), msg('a4', 4)];
    const reply = (unread: number) => ({
      key: 'r',
      kind: 'reply' as const,
      agentId: 'x',
      unread,
      ts: 0,
    });
    expect(cardMessages(reply(1), messages).map((m) => m.id)).toEqual(['a4']);
    expect(cardMessages(reply(9), messages).map((m) => m.id)).toEqual(['a2', 'a3', 'a4']);
    // Read on the desk already: still the newest one.
    expect(cardMessages(reply(0), messages).map((m) => m.id)).toEqual(['a4']);
  });

  it('answers a plain request here, and opens a login, a key or a question in its chat', () => {
    expect(askAction(ask('c', 'x', 0))).toEqual({ kind: 'answer', allow: 'Allow', deny: 'Deny' });
    expect(askAction(ask('c', 'x', 0, { login: {} as never }))).toEqual({
      kind: 'open',
      label: 'Sign in',
    });
    expect(askAction(ask('c', 'x', 0, { secret: {} as never }))).toEqual({
      kind: 'open',
      label: 'Enter key',
    });
    expect(askAction(ask('c', 'x', 0, { prompt: {} as never })).kind).toBe('open');
  });
});
