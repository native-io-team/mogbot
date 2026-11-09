/**
 * A room on the phone, rendered: the thread with each member named over
 * its lines and the user's line saying who it was for, a member's card
 * answerable in place, the @ menu limited to the room, "Who should
 * answer?" before a message nobody would get, and the Rooms section only
 * from a Mac that does rooms.
 */

import type { AgentMessage, RoomView, WelcomeFrame } from '@shipstudio/companion-protocol';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import { RoomComposer, RoomScreen } from '../src/components/rooms';
import { RoomRow } from '../src/components/RoomRow';
import { roomKey } from '../src/lib/rooms';
import { setApp } from '../src/lib/store';
import { agent } from './helpers';

const mockSend = jest.fn((..._args: unknown[]) => Promise.resolve());
const mockPush = jest.fn();

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (fn: () => void | (() => void)) => useEffect(fn, [fn]),
    // The header's title is what a reader sees of the screen's options.
    Stack: {
      Screen: ({ options }: { options?: { headerTitle?: () => ReactNode } }) =>
        options?.headerTitle?.() ?? null,
    },
  };
});
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  for (const k of ['duration', 'delay', 'springify', 'damping', 'mass']) preset[k] = () => preset;
  return {
    __esModule: true,
    default: { View: RN.View, FlatList: RN.FlatList, Text: RN.Text },
    FadeIn: preset,
    FadeOut: preset,
    FadeInDown: preset,
    ZoomIn: preset,
    ZoomOut: preset,
    LinearTransition: preset,
    useSharedValue: (v: unknown) => ({ value: v, set: () => {} }),
    useAnimatedStyle: () => ({}),
    withTiming: (v: unknown) => v,
    withDelay: (_: number, v: unknown) => v,
  };
});
jest.mock('react-native-keyboard-controller', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return { KeyboardChatScrollView: RN.ScrollView, KeyboardStickyView: RN.View };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../src/lib/session', () => ({
  canCall: () => true,
  describeError: String,
  loadLatest: () => Promise.resolve(),
  loadOlder: () => Promise.resolve(),
  setOpenChat: () => {},
  sendToRoom: (...args: unknown[]) => mockSend(...args),
  answerApproval: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/lib/haptics', () => ({
  haptic: {
    select: () => {},
    light: () => {},
    error: () => {},
    success: () => {},
    medium: () => {},
  },
}));
jest.mock('../src/lib/a11y', () => ({ announce: () => {} }));
jest.mock('../src/lib/persist', () => ({
  readJson: () => Promise.resolve(null),
  writeJson: () => Promise.resolve(),
  removeJson: () => Promise.resolve(),
  debounced: () => ({ schedule: () => {}, flush: () => Promise.resolve() }),
}));
// Keys pulse on Reanimated's native half; the room needs only names.
jest.mock('../src/components/agent', () => ({ Spinner: () => null }));
jest.mock('../src/components/AgentKey', () => ({ AgentKey: () => null }));
jest.mock('../src/components/ConversationBars', () => ({ RoomBars: () => null }));

const room = real.roomsList[0] as RoomView;
const thread = real.roomsMessages.messages as AgentMessage[];
const finance = agent({ id: 'a1', name: 'Finance', color: 'green' });
const ops = agent({ id: 'a2', name: 'Ops', color: 'blue', isMain: false });

function state(over: { rooms?: RoomView[]; features?: string[] } = {}) {
  setApp({
    overview: { agents: [finance, ops], engineReady: true, engines: [] } as never,
    link: { kind: 'connected' } as never,
    welcome: {
      methods: ['rooms.list', 'rooms.send', 'agents.answerApproval'],
      features: over.features ?? ['rooms'],
    } as unknown as WelcomeFrame,
    rooms: over.rooms ?? [room],
    chats: { [roomKey(room.id)]: { messages: thread, more: false, loaded: true } },
    composer: {},
    pending: {},
    drafts: {},
  });
}

beforeEach(() => {
  mockSend.mockClear();
  mockPush.mockClear();
  state();
});

describe('a room’s thread', () => {
  it('names each member over its lines, says who you asked, and keeps a member’s card answerable', async () => {
    await render(<RoomScreen id={room.id} />);
    // The header: the room and who is in it.
    expect(screen.getByText('Month end')).toBeTruthy();
    expect(screen.getByText('Finance and Ops')).toBeTruthy();
    // Your line, and whom it went to.
    expect(screen.getByText('@everyone where are we on month end?')).toBeTruthy();
    expect(screen.getByText('To everyone')).toBeTruthy();
    // Each member named over its run; Ops's card and reply are one run.
    expect(screen.getAllByText('Finance')).toHaveLength(1);
    expect(screen.getAllByText('Ops')).toHaveLength(1);
    expect(screen.getByText('Filed.')).toBeTruthy();
    // The card is the chat's own: Allow / Deny, on behalf of Ops.
    expect(screen.getByText('npm run file')).toBeTruthy();
    expect(screen.getAllByText(/Allow/).length).toBeGreaterThan(0);
    // The room's own note, as a quiet line.
    expect(screen.getByText(/nobody else was asked/)).toBeTruthy();
  });

  it('offers a member’s open copy Keep / Discard, and Ask for changes opens its own chat with the request', async () => {
    const withCopy = agent({
      id: 'a1',
      name: 'Finance',
      color: 'green',
      copy: { id: 'copy_1', project: '/p/site', path: '/w/c', branch: 'b' } as never,
    });
    const lines: AgentMessage[] = [
      {
        id: 'c1',
        agentId: 'a1',
        room: room.id,
        ts: 1,
        kind: 'changes',
        text: '',
        changes: {
          project: '/p/site',
          files: [],
          fileCount: 2,
          added: 3,
          removed: 1,
          copy: { id: 'copy_1', path: '/w/c', branch: 'b' },
        } as never,
      },
      {
        id: 'r1',
        agentId: 'a2',
        room: room.id,
        ts: 2,
        kind: 'agent',
        text: 'Done.',
        result: { id: 'res', version: 1, title: 'October close', summary: 'Closed.' },
      },
    ];
    setApp({
      overview: { agents: [withCopy, ops], engineReady: true, engines: [] } as never,
      welcome: {
        methods: [
          'rooms.list',
          'rooms.send',
          'agents.send',
          'agents.keepCopy',
          'agents.discardCopy',
        ],
        features: ['rooms', 'results.revise'],
      } as unknown as WelcomeFrame,
      chats: { [roomKey(room.id)]: { messages: lines, more: false, loaded: true } },
    });
    await render(<RoomScreen id={room.id} />);
    expect(screen.getByText('Keep changes')).toBeTruthy();
    expect(screen.getByText('Discard')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Ask for changes'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/chat/[id]', params: { id: 'a2' } });
    const { getApp } = jest.requireActual<typeof import('../src/lib/store')>('../src/lib/store');
    expect(getApp().composer.a2?.revising).toEqual({
      id: 'res',
      version: 1,
      title: 'October close',
    });
  });

  it('says plainly when the room is gone', async () => {
    state({ rooms: [] });
    await render(<RoomScreen id={room.id} />);
    expect(screen.getByText('This room was deleted')).toBeTruthy();
  });
});

describe('the room’s composer', () => {
  const composer = () => (
    <RoomComposer
      room={room}
      members={[finance, ops]}
      connected
      macName="Julian’s Mac"
      working={false}
      onError={() => {}}
      onSent={() => {}}
    />
  );

  it('offers only the room’s members and everyone after @', async () => {
    setApp({ overview: { agents: [finance, ops, agent({ id: 'x', name: 'Outsider' })] } as never });
    await render(composer());
    await fireEvent.changeText(screen.getByLabelText('Message Month end'), 'hey @');
    expect(screen.getByLabelText('Mention Finance')).toBeTruthy();
    expect(screen.getByLabelText('Mention Ops')).toBeTruthy();
    expect(screen.getByText('everyone')).toBeTruthy();
    expect(screen.queryByText('Outsider')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Mention Ops'));
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Send'));
    });
    expect(mockSend).toHaveBeenCalledWith(room.id, 'hey @Ops', ['a2'], false);
  });

  it('asks who should answer when nobody is named and the room has no lead', async () => {
    await render(composer());
    expect(screen.getByText('Who should answer? @ someone')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Message Month end'), 'Where are we?');
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Send'));
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(screen.getByText('Who should answer?')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Everyone'));
    });
    expect(mockSend).toHaveBeenCalledWith(room.id, 'Where are we?', [], true);
  });

  it('sends to the lead without asking when there is one', async () => {
    await render(
      <RoomComposer
        room={{ ...room, lead: 'a1' }}
        members={[finance, ops]}
        connected
        macName="Mac"
        working={false}
        onError={() => {}}
        onSent={() => {}}
      />
    );
    expect(screen.getByText('To Finance · @ someone else, or @everyone')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Message Month end'), 'Status?');
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Send'));
    });
    expect(mockSend).toHaveBeenCalledWith(room.id, 'Status?', [], false);
  });
});

describe('the room’s row', () => {
  it('says the room needs you while a member’s card waits, and opens the room', async () => {
    await render(<RoomRow room={room} live />);
    expect(screen.getByText('Month end')).toBeTruthy();
    expect(screen.getByText('Needs your OK')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText(/^Room Month end/));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/room/[id]', params: { id: room.id } });
  });
});
