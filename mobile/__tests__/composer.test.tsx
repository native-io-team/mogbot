/**
 * The message field, rendered: shaped as Claude's own input, with the mic
 * always there, so you can talk while an agent works (what you say queues,
 * as what you type does), beside Stop and Send.
 */

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Composer } from '../src/components/Composer';
import { setApp } from '../src/lib/store';
import { agent } from './helpers';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
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

describe('the model chip', () => {
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
  // The chip is in the card's row: a second line makes the card.
  const asCard = async () => {
    await act(async () => {
      await fireEvent.changeText(
        screen.getByLabelText('Message Ops'),
        'the numbers\nand the summary'
      );
    });
  };
  const serve = (a: typeof onOpus, features: string[]) =>
    setApp({
      overview: { agents: [a], engineReady: true, engines } as never,
      link: { kind: 'connected' } as never,
      welcome: { methods: ['agents.files', 'agents.update'], features } as never,
      composer: {},
    });

  it('says the model and effort, and opens Agent controls', async () => {
    serve(onOpus, ['agents.engine', 'agents.effort']);
    await render(composer(onOpus));
    await asCard();
    expect(screen.getByText('Opus 5.5 · High')).toBeTruthy();
    expect(screen.queryByText(/Claude Code/)).toBeNull();
    mockPush.mockClear();
    fireEvent.press(screen.getByLabelText('Runs on Opus 5.5 on Claude Code, High effort'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/controls', params: { id: 'ops' } });
  });

  it('opens them mid-turn too: the level can still change', async () => {
    const busy = {
      ...onOpus,
      status: { state: 'working', activity: 'Thinking', since: 1 },
    } as typeof onOpus;
    serve(busy, ['agents.engine', 'agents.effort']);
    await render(composer(busy));
    await asCard();
    mockPush.mockClear();
    fireEvent.press(screen.getByLabelText(/^Runs on Opus 5\.5/));
    expect(mockPush).toHaveBeenCalled();
  });

  it('is a label on a Mac with nothing to change there', async () => {
    serve(onOpus, []);
    await render(composer(onOpus));
    await asCard();
    expect(screen.getByLabelText(/^Runs on Opus 5\.5/).props.accessibilityRole).toBe('text');
  });
});
