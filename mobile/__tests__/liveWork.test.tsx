/**
 * What an agent is doing, live, on the phone: the list row's words and
 * time, which call the working row is saying, and the working row itself
 * (one line that opens into the steps, the slow-tool hint, "Show output"
 * inside the step it's on, "Stop this step", and the quiet state with
 * "Check on it").
 */

import type { LiveCall, TurnWork, WelcomeFrame } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { LiveStep } from '../src/components/work';
import { subtitle, workingLine } from '../src/lib/agents';
import { setApp } from '../src/lib/store';
import { liveCallShown } from '../src/lib/work';
import { agent } from './helpers';

const mockCall = jest.fn<Promise<string>, [string, unknown]>();
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  preset.duration = () => preset;
  return { __esModule: true, default: { View }, FadeIn: preset };
});
jest.mock('../src/components/TypingDots', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { TypingDots: () => <View testID="typing-dots" /> };
});
jest.mock('../src/components/attachments', () => ({ Attachments: () => null }));
jest.mock('../src/components/Shimmer', () => ({
  Shimmer: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/components/AgentKey', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    AgentKey: ({ state }: { state: string }) => (
      <View testID="key-cap" accessibilityState={{ busy: state === 'working' }} />
    ),
  };
});
jest.mock('expo-haptics', () => ({}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { light: jest.fn(), select: jest.fn(), success: jest.fn(), error: jest.fn() },
}));
jest.mock('../src/lib/session', () => ({
  describeError: String,
  call: (method: string, params: unknown) => mockCall(method, params),
  stop: jest.fn(() => Promise.resolve(true)),
}));

const MIN = 60_000;

const cypress = (over: Partial<LiveCall> = {}): LiveCall => ({
  kind: 'command',
  label: 'Running the Cypress tests',
  startedAt: 0,
  slow: 'tests',
  streams: true,
  canStop: true,
  output: ['✓ shows three plans (812ms)', '1) links each plan to checkout'],
  ...over,
});

const work = (over: Partial<TurnWork> = {}): TurnWork => ({
  startedAt: 0,
  stepCount: 3,
  steps: [],
  fileCount: 0,
  doing: 'Running the Cypress tests',
  current: cypress(),
  lastSignAt: 5.5 * MIN - 4_000,
  ...over,
});

function serve(methods: string[]) {
  setApp({ welcome: { methods, features: [] } as unknown as WelcomeFrame });
}

describe('the list row', () => {
  it('says the live step and how long, not “Working…”', () => {
    const a = agent({
      status: { state: 'working', activity: 'Running the Cypress tests', since: 0, work: work() },
    });
    expect(subtitle(a, 5.5 * MIN)).toBe('Running the Cypress tests · 5m');
  });

  it('falls back to the turn’s time when the overview carries no steps', () => {
    const a = agent({ status: { state: 'working', activity: null, since: 0 } });
    expect(subtitle(a, 42_000)).toBe('Thinking · 42s');
    expect(workingLine(a)).toBe('Thinking');
  });

  it('says it has gone quiet, without a time', () => {
    const a = agent({
      status: { state: 'working', activity: 'x', since: 0, work: work({ quietSince: 0 }) },
    });
    expect(subtitle(a, 5 * MIN)).toBe('No progress for 5 min');
  });

  it('keeps the queued wording', () => {
    const a = agent({
      status: {
        state: 'working',
        activity: 'Waiting for a free slot (4 agents already working)',
        since: null,
      },
    });
    expect(subtitle(a, 1)).toBe('Waiting for a free slot · 4 others working');
  });
});

describe('which call the working row is saying', () => {
  it('is the running call when the line is its words, or says nothing', () => {
    expect(liveCallShown(work(), 'Running the Cypress tests')?.label).toBe(
      'Running the Cypress tests'
    );
    expect(liveCallShown(work(), null)).toBeDefined();
    // Another line ("Reconnecting to Codex") is shown as it is, with no timer.
    expect(liveCallShown(work(), 'Reconnecting to Codex')).toBeUndefined();
    expect(liveCallShown(work({ current: undefined }), null)).toBeUndefined();
  });
});

describe('the live step', () => {
  beforeEach(() => {
    mockCall.mockReset();
    serve(['agents.stopStep', 'agents.checkOn']);
  });

  it('is one line: its words, its steps so far and the turn’s time, then a hint', async () => {
    const w = work();
    const { rerender } = await render(
      <LiveStep agentId="qa" work={w} call={w.current} label="" now={30_000} />
    );
    expect(screen.getByText('Running the Cypress tests')).toBeTruthy();
    expect(screen.getByText('· 3 steps · 0:30')).toBeTruthy();
    expect(screen.queryByText('Test runs usually take a few minutes')).toBeNull();
    // Output lives in its step, not under the line.
    expect(screen.queryByText('Show output')).toBeNull();
    await rerender(<LiveStep agentId="qa" work={w} call={w.current} label="" now={5.5 * MIN} />);
    expect(screen.getByText('· 3 steps · 5:30')).toBeTruthy();
    expect(screen.getByText('Test runs usually take a few minutes')).toBeTruthy();
    expect(screen.queryByText('Stop this step')).toBeNull();
  });

  it('opens into the steps, ending on the one it’s on with its output', async () => {
    const w = work();
    const { rerender } = await render(
      <LiveStep agentId="qa" work={w} call={w.current} label="" now={MIN} />
    );
    await fireEvent.press(screen.getByTestId('live-step'));
    expect(screen.getByTestId('work-step-current')).toBeTruthy();
    await fireEvent.press(screen.getByText('Show output'));
    expect(screen.getByText('1) links each plan to checkout')).toBeTruthy();
    const quiet = work({ current: cypress({ streams: false, output: undefined }) });
    await rerender(<LiveStep agentId="qa" work={quiet} call={quiet.current} label="" now={MIN} />);
    expect(screen.getByText('Output appears when it finishes')).toBeTruthy();
  });

  it('says when it last showed life inside the step, once opened', async () => {
    const w = work({ current: cypress({ busy: true }) });
    await render(<LiveStep agentId="qa" work={w} call={w.current} label="" now={5.5 * MIN} />);
    expect(screen.queryByTestId('life-line')).toBeNull();
    await fireEvent.press(screen.getByTestId('live-step'));
    expect(screen.getByText('Last activity 4s ago · busy')).toBeTruthy();
  });

  it('offers to stop the step after ten minutes, and says what the Mac did', async () => {
    mockCall.mockResolvedValue('Stopped that step. It carries on from there.');
    const w = work();
    await render(<LiveStep agentId="qa" work={w} call={w.current} label="" now={11 * MIN} />);
    await fireEvent.press(screen.getByText('Stop this step'));
    expect(await screen.findByText('Stopped that step. It carries on from there.')).toBeTruthy();
    expect(mockCall).toHaveBeenCalledWith('agents.stopStep', { agentId: 'qa' });
  });

  it('never offers what an older Mac can’t do', async () => {
    serve([]);
    const w = work({ quietSince: 0 });
    await render(<LiveStep agentId="qa" work={w} call={w.current} label="" now={11 * MIN} />);
    expect(screen.queryByText('Stop this step')).toBeNull();
    expect(screen.queryByText('Check on it')).toBeNull();
    // Stop (the whole turn) is always there.
    expect(screen.getByText('Stop')).toBeTruthy();
  });

  it('goes quiet gently, and checks on it without stopping it', async () => {
    mockCall.mockResolvedValue(
      'Still going: running the Cypress tests is busy right now.'
    );
    const w = work({ quietSince: 0 });
    await render(
      <LiveStep
        agentId="qa"
        agent={{ name: 'QA', color: 'green' }}
        work={w}
        call={w.current}
        label=""
        now={5 * MIN}
      />
    );
    expect(screen.getByText('No progress for 5 min · Running the Cypress tests')).toBeTruthy();
    // No step timer, no output toggle, no dots claiming it's busy: its key cap leads.
    expect(screen.queryByText('5:00')).toBeNull();
    expect(screen.queryByText('Show output')).toBeNull();
    expect(screen.queryByTestId('typing-dots')).toBeNull();
    // Gone quiet, the key rests rather than staying pressed.
    expect(screen.getByTestId('key-cap').props.accessibilityState).toEqual({ busy: false });
    await fireEvent.press(screen.getByText('Check on it'));
    expect(
      await screen.findByText('Still going: running the Cypress tests is busy right now.')
    ).toBeTruthy();
    expect(mockCall).toHaveBeenCalledWith('agents.checkOn', { agentId: 'qa' });
  });
});
