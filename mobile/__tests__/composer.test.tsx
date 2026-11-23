/**
 * The message field, rendered: shaped as Claude's own input. The mic is there
 * only while the box is empty (so you can talk while an agent works, and what
 * you say queues); an empty box shows Stop in Send's place while it works, and
 * typed words bring Send (queue) back. The model is not in the box.
 */

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { Composer } from '../src/components/Composer';
import { setApp } from '../src/lib/store';
import { agent } from './helpers';

jest.mock('react-native-gesture-handler', () => require('./gestureStub').gestureHandler());
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
jest.mock('../src/components/AgentKey', () => ({ AgentKey: () => null }));
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
  it('shows the mic and Stop in Send’s place while the agent works and the box is empty', async () => {
    state(working);
    await render(composer(working));
    expect(screen.getByLabelText('Dictate')).toBeTruthy();
    expect(screen.getByLabelText('Stop Ops')).toBeTruthy();
    expect(screen.queryByLabelText('Send')).toBeNull();
  });

  it('stops the turn when Stop is pressed', async () => {
    const { stop } = jest.requireMock<{ stop: jest.Mock }>('../src/lib/session');
    stop.mockClear();
    state(working);
    await render(composer(working));
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Stop Ops'));
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the mic once there are words, and Send takes Stop’s place', async () => {
    state();
    await render(composer());
    await act(async () => {
      await fireEvent.changeText(screen.getByLabelText('Message Ops'), 'hello');
    });
    expect(screen.getByLabelText('Dictate')).toBeTruthy();
    expect(screen.getByLabelText('Send').props.accessibilityState).toMatchObject({
      disabled: false,
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

  it('keeps its buttons on the field’s bottom inset however tall the input comes out', async () => {
    state();
    await render(composer());
    const pill = StyleSheet.flatten(screen.getByTestId('composer-pill').props.style);
    expect(pill.alignItems).toBe('flex-end');
    expect(pill.minHeight).toBeGreaterThanOrEqual(48);
  });

  it('says it queues while the agent works, with Send now on that line', async () => {
    state(working);
    await render(composer(working));
    await act(async () => {
      await fireEvent.changeText(screen.getByLabelText('Message Ops'), 'and then the summary');
    });
    expect(screen.getByText('Next, after this one')).toBeTruthy();
    expect(screen.getByLabelText('Send now: interrupt Ops and send')).toBeTruthy();
    expect(screen.getByLabelText('Queue: Ops reads it next, after this one')).toBeTruthy();
    // Words typed: the mic stays, and Stop gives Send its place back.
    expect(screen.getByLabelText('Dictate')).toBeTruthy();
    expect(screen.queryByLabelText('Stop Ops')).toBeNull();
  });

  it('Send now sends with the interrupt (kept in the outbox if it has to wait)', async () => {
    const { send } = jest.requireMock<{ send: jest.Mock }>('../src/lib/session');
    send.mockClear();
    state(working);
    await render(composer(working));
    await act(async () => {
      await fireEvent.changeText(screen.getByLabelText('Message Ops'), 'stop, use the other file');
    });
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Send now: interrupt Ops and send'));
    });
    expect(send).toHaveBeenCalledWith(
      'ops',
      'stop, use the other file',
      true,
      undefined,
      expect.anything(),
      expect.anything(),
      undefined,
      undefined
    );
  });
});

describe('the model', () => {
  const engines = [
    {
      id: 'claude',
      label: 'Claude Code',
      installed: true,
      signedIn: true,
      asks: true,
      models: [{ value: 'opus', label: 'Opus' }],
    },
  ];
  const onOpus = agent({
    id: 'ops',
    name: 'Ops',
    effort: 'high',
    context: { used: 1, window: 200_000, at: 1, model: 'claude-opus-5-5' },
  });

  it('is not in the box, even in the card’s row; it is under ⋯ “Model and controls”', async () => {
    setApp({
      overview: { agents: [onOpus], engineReady: true, engines } as never,
      link: { kind: 'connected' } as never,
      welcome: {
        methods: ['agents.files', 'agents.update'],
        features: ['agents.engine', 'agents.effort'],
      } as never,
      composer: {},
    });
    await render(composer(onOpus));
    await act(async () => {
      await fireEvent.changeText(
        screen.getByLabelText('Message Ops'),
        'the numbers\nand the summary'
      );
    });
    expect(screen.queryByText(/Opus 5\.5/)).toBeNull();
    expect(screen.queryByLabelText(/^Runs on /)).toBeNull();
  });
});
