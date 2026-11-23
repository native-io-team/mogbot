/**
 * The Rooms section of the agents list: there for a Mac whose welcome says
 * it does rooms, absent for an older one even with rooms kept from before.
 */

import type { RoomView, WelcomeFrame } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import Agents from '../src/app/(tabs)/agents/index';
import { defaultPrefs, setApp } from '../src/lib/store';
import { readPrefs } from '../src/lib/prefs';
import { agent } from './helpers';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useFocusEffect: () => {},
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
jest.mock('../src/lib/glance', () => ({ useGlance: () => null }));
jest.mock('../src/components/ChatView', () => ({ ChatView: () => null }));
jest.mock('../src/components/ConnectionPill', () => ({
  ConnectionBar: () => null,
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
    prefs: defaultPrefs,
  });
}

it('lists rooms, with their members, from a Mac that does rooms', async () => {
  state(['rooms']);
  await render(<Agents />);
  expect(screen.getByText('Rooms')).toBeTruthy();
  expect(screen.getByText('Agents')).toBeTruthy();
  expect(screen.getByText('Month end')).toBeTruthy();
});

it('shows no rooms from a Mac that doesn’t say it does them', async () => {
  state(undefined);
  await render(<Agents />);
  expect(screen.queryByText('Rooms')).toBeNull();
  expect(screen.queryByText('Month end')).toBeNull();
  expect(screen.getByText('Finance')).toBeTruthy();
});

it('folds Rooms on a tap and opens them again', async () => {
  state(['rooms']);
  await render(<Agents />);
  await fireEvent.press(screen.getByLabelText('Rooms'));
  expect(screen.queryByText('Month end')).toBeNull();
  expect(screen.getByText('Finance')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Rooms'));
  expect(screen.getByText('Month end')).toBeTruthy();
});

it('folds a folder made on the Mac, leaving the others open', async () => {
  state(['rooms']);
  setApp({
    overview: {
      agents: [
        { ...finance, folder: 'f1', pinned: false },
        { ...ops, pinned: false },
      ],
      folders: { folders: [{ id: 'f1', name: 'Clients' }] },
      engineReady: true,
      engines: [],
    } as never,
  });
  await render(<Agents />);
  expect(screen.getByText('Finance')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Clients'));
  expect(screen.queryByText('Finance')).toBeNull();
  expect(screen.getByText('Ops')).toBeTruthy();
});

it('keeps only names in the saved folds', () => {
  expect(readPrefs({ folded: ['rooms', 3, 'folder:f1'] as never }).folded).toEqual([
    'rooms',
    'folder:f1',
  ]);
  expect(readPrefs({ folded: 'rooms' as never }).folded).toEqual([]);
  expect(readPrefs(null).folded).toEqual([]);
});
