/**
 * The message field, rendered: shaped as Claude's own input, with the mic
 * always there, so you can talk while an agent works (what you say queues,
 * as what you type does), beside Stop and Send.
 */

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Composer } from '../src/components/Composer';
import { setApp } from '../src/lib/store';
import { agent } from './helpers';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  for (const k of ['duration', 'delay', 'springify', 'damping', 'mass']) preset[k] = () => preset;
  return {
    __esModule: true,
    default: { View: RN.View, FlatList: RN.FlatList, Text: RN.Text },
    FadeIn: preset,
    FadeOut: preset,
    ZoomIn: preset,
    ZoomOut: preset,
    LinearTransition: preset,
    cancelAnimation: () => {},
    useReducedMotion: () => true,
    useSharedValue: (v: unknown) => ({ value: v, get: () => v, set: () => {} }),
    useAnimatedStyle: () => ({}),
    useFrameCallback: () => {},
    withRepeat: (v: unknown) => v,
    withSequence: (v: unknown) => v,
    withTiming: (v: unknown) => v,
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../src/lib/session', () => ({
  describeError: String,
  send: jest.fn(() => Promise.resolve()),
  stop: jest.fn(() => Promise.resolve()),
  upload: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { select: () => {}, light: () => {}, error: () => {}, medium: () => {} },
}));
jest.mock('../src/lib/persist', () => ({
  readJson: () => Promise.resolve(null),
  writeJson: () => Promise.resolve(),
  removeJson: () => Promise.resolve(),
  debounced: () => ({ schedule: () => {}, flush: () => Promise.resolve(), cancel: () => {} }),
}));
jest.mock('../src/components/agent', () => ({ AgentAvatar: () => null }));
jest.mock('../src/components/ConversationBars', () => ({ ConversationBars: () => null }));

const idle = agent({ id: 'ops', name: 'Ops' });
const working = agent({
  id: 'ops',
  name: 'Ops',
  status: { state: 'working', activity: 'Thinking', since: 1 },
});

function state(a = idle) {
  setApp({
    overview: { agents: [a], engineReady: true, engines: [] } as never,
    link: { kind: 'connected' } as never,
    welcome: { methods: ['agents.files'], features: [] } as never,
    composer: {},
  });
}

const composer = (a = idle) => (
  <Composer agent={a} connected macName="Mac" onError={() => {}} onSent={() => {}} />
);

describe('the message field', () => {
  it('keeps the mic while the agent works, beside Stop and Send', async () => {
    state(working);
    await render(composer(working));
    expect(screen.getByLabelText('Dictate')).toBeTruthy();
    expect(screen.getByLabelText('Stop Ops')).toBeTruthy();
    // Nothing typed yet: Send is there, dimmed, and queues once there's something.
    expect(screen.getByLabelText('Send').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('has the + inside it, and the mic and a dimmed Send when empty', async () => {
    state();
    await render(composer());
    expect(screen.getByLabelText('Attach files')).toBeTruthy();
    expect(screen.getByLabelText('Dictate')).toBeTruthy();
    expect(screen.getByLabelText('Send').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(screen.queryByLabelText(/^Stop /)).toBeNull();
  });

  it('says it queues while the agent works, with Send now on that line', async () => {
    state(working);
    await render(composer(working));
    await act(async () => {
      await fireEvent.changeText(screen.getByLabelText('Message Ops'), 'and then the summary');
    });
    expect(screen.getByText('Ops reads it when this turn ends')).toBeTruthy();
    expect(screen.getByLabelText('Send now: interrupt Ops and send')).toBeTruthy();
    expect(screen.getByLabelText('Queue: Ops reads it when this turn ends')).toBeTruthy();
    expect(screen.getByLabelText('Dictate')).toBeTruthy();
  });
});
