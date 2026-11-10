/**
 * The Catch up tab, rendered: the headline count, one group per agent, a
 * short low-risk card answered on its row while a risky one only says
 * Review, an answered card leaving, and the all-clear handing you to Agents.
 */

import type { AgentMessage, Approval, WelcomeFrame } from '@shipstudio/companion-protocol';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import CatchUp from '../src/app/(tabs)/catch-up/index';
import { setApp } from '../src/lib/store';
import { agent, msg } from './helpers';

const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockAnswer = jest.fn((..._args: unknown[]) => Promise.resolve());

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: mockPush, navigate: mockNavigate, back: jest.fn() }),
    useFocusEffect: (fn: () => void | (() => void)) => useEffect(fn, [fn]),
    Stack: { Screen: () => null },
  };
});
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  for (const k of ['duration', 'delay', 'reduceMotion']) preset[k] = () => preset;
  return {
    __esModule: true,
    default: { View: RN.View, Text: RN.Text },
    FadeIn: preset,
    FadeOut: preset,
    LinearTransition: preset,
    ReduceMotion: { System: 'system' },
    interpolate: () => 1,
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    withTiming: (v: unknown) => v,
  };
});
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RN.View };
});
jest.mock('../src/lib/session', () => ({
  canCall: () => true,
  describeError: String,
  loadLatest: () => Promise.resolve(),
  answerApproval: (...args: unknown[]) => mockAnswer(...args),
  discardCopy: jest.fn(),
  keepCopy: jest.fn(),
  unpair: jest.fn(),
}));
jest.mock('../src/lib/landing', () => ({
  loadSeen: () => Promise.resolve(Date.now()),
  markSeen: () => {},
}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { select: () => {}, success: () => {}, warning: () => {}, error: () => {} },
}));
jest.mock('../src/components/ConnectionPill', () => ({
  ConnectionBar: () => null,
  useNow: () => Date.now(),
}));
jest.mock('../src/components/AgentKey', () => ({ AgentKey: () => null }));

const approval = (requestId: string, over: Partial<Approval> = {}): Approval =>
  ({ requestId, title: 'Run a command', detail: 'ls', status: 'pending', ...over }) as Approval;
const ask = (id: string, agentId: string, ts: number, over: Partial<Approval> = {}) =>
  msg(id, ts, { agentId, kind: 'approval', text: '', approval: approval(id, over) });

const site = agent({ id: 'site', name: 'Acme Site', isMain: false, pendingApprovals: 1 });
const ops = agent({ id: 'ops', name: 'Ops', isMain: false, pendingApprovals: 1 });

function state(chats: Record<string, AgentMessage[]>, agents = [site, ops]) {
  setApp({
    overview: { agents, engineReady: true, engines: [] } as never,
    link: { kind: 'connected' } as never,
    welcome: { methods: ['agents.answerApproval'], features: [] } as unknown as WelcomeFrame,
    chats: Object.fromEntries(
      Object.entries(chats).map(([id, messages]) => [id, { messages, more: false, loaded: true }])
    ),
    teamSetup: null,
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockPush.mockClear();
  mockNavigate.mockClear();
  mockAnswer.mockClear();
});
afterEach(() => jest.useRealTimers());

describe('Catch up', () => {
  it('counts, groups by agent, answers a low-risk card in place and only reviews a risky one', async () => {
    state({
      site: [
        ask('s1', 'site', 10, { risk: 'low', title: 'List files', summary: 'List the folder' }),
      ],
      ops: [ask('o1', 'ops', 20, { risk: 'high', title: 'Delete files', detail: 'rm -r out' })],
    });
    await render(<CatchUp />);
    expect(screen.getByText('2 things need you')).toBeTruthy();
    expect(screen.getByText('From 2 agents')).toBeTruthy();
    expect(screen.getByText('Acme Site')).toBeTruthy();
    expect(screen.getByText('Ops')).toBeTruthy();
    // One Allow on screen: the low-risk card's. The risky one says Review.
    expect(screen.getAllByText('Allow')).toHaveLength(1);
    expect(screen.getByText('Review')).toBeTruthy();
    expect(screen.getByTestId('catch-up-risky')).toBeTruthy();

    // Allow is inert for a beat, then answers the low-risk card.
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Allow'));
    });
    expect(mockAnswer).toHaveBeenCalledWith('site', 's1', true, false);

    // Review opens the risky one in full.
    fireEvent.press(screen.getByText('Review'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/request',
      params: { agent: 'ops', id: 'o1' },
    });
  });

  it('an answered card leaves, and the agent with it', async () => {
    state({
      site: [ask('s1', 'site', 10, { risk: 'low' })],
      ops: [ask('o1', 'ops', 20, { risk: 'high', title: 'Delete files' })],
    });
    await render(<CatchUp />);
    expect(screen.getByText('Acme Site')).toBeTruthy();
    await act(async () => {
      state(
        {
          site: [ask('s1', 'site', 10, { risk: 'low', status: 'allowed' })],
          ops: [ask('o1', 'ops', 20, { risk: 'high', title: 'Delete files' })],
        },
        [{ ...site, pendingApprovals: 0 }, ops]
      );
    });
    expect(screen.queryByText('Acme Site')).toBeNull();
    expect(screen.getByText('1 thing needs you')).toBeTruthy();
  });

  it('all clear: says so, and hands you to Agents', async () => {
    state({ site: [], ops: [] }, [
      { ...site, pendingApprovals: 0 },
      { ...ops, pendingApprovals: 0 },
    ]);
    await render(<CatchUp />);
    expect(screen.getByText('All caught up')).toBeTruthy();
    fireEvent.press(screen.getByText('Go to Agents'));
    expect(mockNavigate).toHaveBeenCalledWith('/agents');
  });
});
