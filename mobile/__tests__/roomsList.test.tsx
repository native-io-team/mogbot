/**
 * The Rooms section of the agents list: there for a Mac whose welcome says
 * it does rooms, absent for an older one even with rooms kept from before.
 */

import type { RoomView, WelcomeFrame } from '@shipstudio/companion-protocol';
import { render, screen } from '@testing-library/react-native';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import Agents from '../src/app/(tabs)/agents/index';
import { setApp } from '../src/lib/store';
import { agent } from './helpers';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
  Link: ({ children }: { children: unknown }) => children,
}));
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  for (const k of ['duration', 'delay', 'springify', 'damping', 'mass']) preset[k] = () => preset;
  return {
    __esModule: true,
    default: { View: RN.View, FlatList: RN.FlatList },
    FadeIn: preset,
    FadeOut: preset,
    FadeInDown: preset,
    LinearTransition: preset,
    interpolate: () => 0,
    useAnimatedStyle: () => ({}),
    useSharedValue: (v: number) => ({ value: v }),
    withTiming: (v: number) => v,
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RN.View };
});
jest.mock('../src/lib/session', () => ({
  canCall: () => false,
  describeError: String,
  call: jest.fn(),
}));
jest.mock('../src/lib/quota', () => ({ useQuotaLines: () => [] }));
jest.mock('../src/components/QuotaLines', () => ({ QuotaLines: () => null }));
jest.mock('../src/components/ChatView', () => ({ ChatView: () => null }));
jest.mock('../src/components/ConnectionPill', () => ({
  ConnectionNotice: () => null,
  useLinkState: () => null,
  useNow: () => Date.now(),
}));
jest.mock('../src/components/AgentKey', () => ({ AgentKey: () => null }));
jest.mock('../src/components/agent', () => ({
  Spinner: () => null,
  StatusMark: () => null,
}));

const room = real.roomsList[0] as RoomView;
const finance = agent({ id: 'a1', name: 'Finance' });
const ops = agent({ id: 'a2', name: 'Ops', isMain: false });

function state(features: string[] | undefined) {
  setApp({
    overview: { agents: [finance, ops], engineReady: true, engines: [] } as never,
    link: { kind: 'connected' } as never,
    welcome: {
      methods: ['rooms.list', 'rooms.send'],
      ...(features ? { features } : {}),
    } as unknown as WelcomeFrame,
    rooms: [room],
    chats: {},
  });
}

it('lists rooms, with their members, from a Mac that does rooms', async () => {
  state(['rooms']);
  await render(<Agents />);
  expect(screen.getByText('ROOMS')).toBeTruthy();
  expect(screen.getByText('AGENTS')).toBeTruthy();
  expect(screen.getByText('Month end')).toBeTruthy();
});

it('shows no rooms from a Mac that doesn’t say it does them', async () => {
  state(undefined);
  await render(<Agents />);
  expect(screen.queryByText('ROOMS')).toBeNull();
  expect(screen.queryByText('Month end')).toBeNull();
  expect(screen.getByText('Finance')).toBeTruthy();
});
