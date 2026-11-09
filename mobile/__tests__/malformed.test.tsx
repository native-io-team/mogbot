/**
 * A message from a Mac older or newer than this phone (a field missing, a
 * wrong type, a kind it has never heard of) is drawn, or says in one Line
 * that it couldn't be; it never takes the chat, or the app, down with it.
 */

import type { AgentMessage, CompanionEvent } from '@shipstudio/companion-protocol';
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { MessageRow } from '../src/components/chat';
import { ROW_ERROR, RowBoundary, rowResetKey } from '../src/components/RowBoundary';
import { applyEvent, confirmSend, emptySync, mergePage } from '../src/lib/sync';
import { asMessage, asMessages } from '../src/lib/wellFormed';
import { agent } from './helpers';

const mockRecordCrash = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('../src/lib/crash', () => ({
  recordCrash: (...a: unknown[]) => mockRecordCrash(...a),
}));
jest.mock('react-native-reanimated', () => {
  const { View, FlatList } = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  for (const k of ['duration', 'delay', 'springify', 'damping']) preset[k] = () => preset;
  return {
    __esModule: true,
    default: { View, FlatList },
    FadeIn: preset,
    FadeInDown: preset,
    FadeOut: preset,
    ZoomIn: preset,
    ZoomOut: preset,
    LinearTransition: preset,
    useReducedMotion: () => true,
    useSharedValue: (v: unknown) => ({ value: v, set: () => {} }),
    useAnimatedStyle: () => ({}),
    withSequence: () => 0,
    withTiming: () => 0,
    Easing: { out: () => 0, inOut: () => 0, quad: 0 },
  };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-haptics', () => ({}));
jest.mock('../src/lib/haptics', () => ({
  haptic: {
    light: jest.fn(),
    select: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('../src/lib/session', () => ({
  answerApproval: jest.fn(),
  keepCopy: jest.fn(),
  discardCopy: jest.fn(),
  saveSecret: jest.fn(),
  currentTransport: () => ({ route: 'tailscale' }),
  secretRouteProblem: () => null,
  describeError: String,
  discardPending: jest.fn(),
  editPending: jest.fn(),
  send: jest.fn(),
  resend: jest.fn(),
  revokePermission: jest.fn(),
  canCall: () => false,
}));

beforeEach(() => mockRecordCrash.mockClear());

const event = (message: unknown) =>
  ({ type: 'agents.message', message }) as unknown as CompanionEvent;

/** React logs a caught render error; the test says what it expects instead. */
function quietly() {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  return () => spy.mockRestore();
}

describe('asMessage', () => {
  it('leaves out what is not a message', () => {
    for (const raw of [null, undefined, 3, 'hi', [], {}, { id: '' }, { id: 7 }]) {
      expect(asMessage(raw)).toBeNull();
    }
  });

  it('makes the fields every row reads safe', () => {
    const m = asMessage({ id: 'm1', text: 42, ts: 'soon', kind: null });
    expect(m).toEqual({ id: 'm1', agentId: '', text: '42', ts: 0, kind: 'note' });
    expect(asMessage({ id: 'm2' })?.text).toBe('');
  });

  it('drops a field of the wrong shape and keeps an unknown kind and unknown fields', () => {
    const m = asMessage({
      id: 'm3',
      agentId: 'a',
      ts: 5,
      kind: 'hologram',
      text: 'From the future',
      approval: 'yes',
      attachments: { name: 'x' },
      mentions: [null, { id: 'b', name: 'B' }, 'c'],
      room: 12,
      futureField: { any: 'thing' },
    })!;
    expect(m.kind).toBe('hologram');
    expect(m.approval).toBeUndefined();
    expect(m.attachments).toBeUndefined();
    expect(m.mentions).toEqual([{ id: 'b', name: 'B' }]);
    expect(m.room).toBeUndefined();
    expect((m as unknown as Record<string, unknown>).futureField).toEqual({ any: 'thing' });
  });

  it('reads a page that is not a list as empty', () => {
    expect(asMessages(undefined)).toEqual([]);
    expect(asMessages([{ id: 'a' }, null, 'x']).map((m) => m.id)).toEqual(['a']);
  });
});

describe('sync, given a malformed message', () => {
  it('skips one that is not a message and keeps one with odd fields', () => {
    let s = emptySync();
    expect(() => {
      s = applyEvent(s, event(null));
      s = applyEvent(s, event({ text: 'no id' }));
      s = applyEvent(s, event({ id: 'm1', agentId: 'a', ts: 'late', text: null }));
    }).not.toThrow();
    expect(s.chats.a.messages).toEqual([
      expect.objectContaining({ id: 'm1', ts: 0, text: '', kind: 'note' }),
    ]);
  });

  it('merges a page with junk in it, or no list and no cursor at all', () => {
    const page = {
      messages: [null, { id: 'p1', agentId: 'a', ts: 1, kind: 'agent', text: 'hi' }, 4],
      more: 'maybe',
    } as never;
    const s = mergePage(emptySync(), 'a', page, false);
    expect(s.chats.a.messages.map((m) => m.id)).toEqual(['p1']);
    expect(s.chats.a.more).toBe(false);
    expect(() => mergePage(emptySync(), 'a', {} as never, false)).not.toThrow();
  });

  it('settles a send whose answer came back unreadable', () => {
    const s = {
      ...emptySync(),
      pending: { a: [{ clientId: 'c1', agentId: 'a', text: 'hi', ts: 1, failed: false }] },
    };
    const after = confirmSend(s, 'c1', null as never);
    expect(after.pending.a).toEqual([]);
  });
});

describe('a row', () => {
  function Boom(): never {
    throw new Error('card from the future');
  }

  it('that throws while drawing is one Line; the rows around it still draw', async () => {
    const restore = quietly();
    await render(
      <>
        <Text>Before</Text>
        <RowBoundary resetKey="x">
          <Boom />
        </RowBoundary>
        <Text>After</Text>
      </>
    );
    expect(screen.getByText(ROW_ERROR)).toBeTruthy();
    expect(screen.getByText('Before')).toBeTruthy();
    expect(screen.getByText('After')).toBeTruthy();
    expect(mockRecordCrash).toHaveBeenCalledWith(expect.any(Error), 'render', false);
    restore();
  });

  it('draws again when a new copy of the message arrives, not on every render', async () => {
    const restore = quietly();
    let broken = true;
    function Maybe() {
      if (broken) throw new Error('bad');
      return <Text>Fixed</Text>;
    }
    const view = await render(
      <RowBoundary resetKey={1}>
        <Maybe />
      </RowBoundary>
    );
    expect(screen.getByText(ROW_ERROR)).toBeTruthy();
    broken = false;
    await view.rerender(
      <RowBoundary resetKey={1}>
        <Maybe />
      </RowBoundary>
    );
    expect(screen.getByText(ROW_ERROR)).toBeTruthy();
    await view.rerender(
      <RowBoundary resetKey={2}>
        <Maybe />
      </RowBoundary>
    );
    expect(screen.getByText('Fixed')).toBeTruthy();
    restore();
  });

  it('keys a message row by the message, any other by kind and key', () => {
    const m = { id: 'x' };
    expect(rowResetKey({ kind: 'message', key: 'x', message: m })).toBe(m);
    expect(rowResetKey({ kind: 'day', key: 'd1' })).toBe('day:d1');
  });

  it('of an unknown kind from a newer Mac is drawn as a plain line of its text', async () => {
    const m = asMessage({ id: 'n1', agentId: 'a', ts: 1, kind: 'hologram', text: 'Projected' })!;
    await render(
      <RowBoundary resetKey={m}>
        <MessageRow message={m} agent={agent()} queued={false} onError={() => {}} />
      </RowBoundary>
    );
    expect(screen.getByText('Projected')).toBeTruthy();
  });

  it.each<[string, Record<string, unknown>]>([
    ['an approval with no fields', { kind: 'approval', approval: {} }],
    ['a result card with no fields', { kind: 'agent', result: {} }],
    ['an error with an empty failure', { kind: 'error', failure: {} }],
    ['a change summary with no fields', { kind: 'changes', changes: {} }],
    ['a session with no fields', { kind: 'session', session: {} }],
    ['a check-in with no fields', { kind: 'check_in', checkIn: {} }],
    ['a peer line with an empty peer', { kind: 'from_agent', peer: {} }],
    [
      'an agent reply with empty attachments, links and decisions',
      { kind: 'agent', attachments: [{}], localLinks: [{}], decide: [{}] },
    ],
    ['a user line with an empty via and revises', { kind: 'user', via: {}, revises: {} }],
    ['a note with an empty remembered rule', { kind: 'note', remembered: {} }],
    ['an agent reply with an empty work timeline', { kind: 'agent', work: {} }],
  ])('%s never takes the chat down', async (_name, extra) => {
    const restore = quietly();
    const m: AgentMessage = asMessage({ id: 'w', agentId: 'a', ts: 1, text: 'Words', ...extra })!;
    await render(
      <>
        <RowBoundary resetKey={m}>
          <MessageRow message={m} agent={agent()} queued={false} onError={() => {}} />
        </RowBoundary>
        <Text>Still here</Text>
      </>
    );
    expect(screen.getByText('Still here')).toBeTruthy();
    restore();
  });
});
