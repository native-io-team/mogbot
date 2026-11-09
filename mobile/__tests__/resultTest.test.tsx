import type { AgentMessage, ResultCard, WelcomeFrame } from '@shipstudio/companion-protocol';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ResultCardView } from '../src/components/result';
import { useApp } from '../src/lib/store';
import { agent } from './helpers';

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  preset.duration = () => preset;
  preset.delay = () => preset;
  return {
    __esModule: true,
    default: { View },
    FadeIn: preset,
    FadeOut: preset,
    LinearTransition: preset,
  };
});
jest.mock('expo-haptics', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-image', () => ({ Image: () => null }));
const mockWatchLive = jest.fn();
jest.mock('../src/lib/session', () => ({
  answerApproval: jest.fn(),
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  watchLive: (...a: unknown[]) => mockWatchLive(...a),
}));
const mockOpenHere = jest.fn();
jest.mock('../src/lib/logins', () => ({ openHere: (u: string) => mockOpenHere(u) }));
jest.mock('../src/lib/haptics', () => ({
  haptic: { light: jest.fn(), select: jest.fn(), success: jest.fn(), error: jest.fn() },
}));
jest.mock('../src/components/attachments', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Attachments: ({ attachments }: { attachments: { name: string }[] }) => (
      <Text>{attachments.map((a) => a.name).join(', ')}</Text>
    ),
  };
});

const shot = (n: number) => ({
  name: `step-${n}.png`,
  path: `attachments/run1/step-${n}.png`,
  mime: 'image/png',
  size: 10,
});

const tested: ResultCard = {
  id: 'res-hero',
  version: 2,
  title: 'Phone hero',
  summary: 'Hero padding is 24px on phones.',
  changes: 'Tested it in the preview: 1 thing is broken',
  project: '/Users/you/ShipStudio/harbor-bakery',
  test: {
    outcome: 'broken',
    summary: 'Home works. Sign up errors after sending.',
    broken: ['Sign up shows “Something went wrong”'],
    consoleErrors: ['POST /api/signup 500', 'TypeError: plan is undefined'],
    steps: [
      { kind: 'open', label: 'Opened /', ok: true, ts: 1 },
      { kind: 'shot', label: 'Home page', ok: true, shot: shot(1), ts: 2 },
      { kind: 'click', label: 'Clicked “Sign up”', ok: true, ts: 3 },
      { kind: 'shot', label: 'Sign-up error', ok: true, shot: shot(2), ts: 4 },
    ],
  },
};

const message: AgentMessage = {
  id: 'run1',
  agentId: 'a',
  ts: 1,
  kind: 'agent',
  text: 'Tested.',
  result: tested,
} as AgentMessage;

const welcome = (methods: string[]) =>
  useApp.setState({
    link: { kind: 'connected', route: 'tailscale' } as never,
    welcome: { methods } as unknown as WelcomeFrame,
  });

function show(card: ResultCard = tested, onError = jest.fn()) {
  return render(
    <ResultCardView
      message={{ ...message, result: card }}
      card={card}
      agent={agent()}
      newest
      onError={onError}
    />
  );
}

beforeEach(() => {
  mockWatchLive.mockReset();
  mockOpenHere.mockReset();
});

describe('a tested card on the phone', () => {
  it('says what the test found, then pages its screenshots with their steps', async () => {
    welcome([]);
    await show();
    expect(screen.getByText('Tested in the preview: 1 thing is broken')).toBeTruthy();
    expect(screen.getByText('• Sign up shows “Something went wrong”')).toBeTruthy();
    expect(screen.getByText('2 console errors')).toBeTruthy();
    // The strip waits for its width, then shows one page per screenshot.
    expect(screen.queryByTestId('result-test-strip')).toBeNull();
    await act(async () => {
      fireEvent(screen.getByTestId('result-test'), 'layout', {
        nativeEvent: { layout: { width: 320, height: 400, x: 0, y: 0 } },
      });
    });
    const strip = screen.getByTestId('result-test-strip');
    expect(strip.props.pagingEnabled).toBe(true);
    expect(strip.props.horizontal).toBe(true);
    expect(screen.getByText('1 of 2 · Home page')).toBeTruthy();
    expect(screen.getByText('2 of 2 · Sign-up error')).toBeTruthy();
    expect(screen.getByText('step-1.png')).toBeTruthy();
  });

  it('a card without a test shows none of it', async () => {
    welcome([]);
    const { test: _drop, ...plain } = tested;
    await show(plain);
    expect(screen.queryByTestId('result-test')).toBeNull();
  });

  it('offers Watch live only when the Mac serves it, and only for a card with a project', async () => {
    welcome([]);
    await show();
    expect(screen.queryByText('Watch live')).toBeNull();
    welcome(['agents.watchLive']);
    await show();
    expect(screen.getByText('Watch live')).toBeTruthy();
    const { project: _p, ...noProject } = tested;
    await show(noProject);
    expect(screen.queryByText('Watch live')).toBeNull();
  });

  it('opens the one-time tailnet link the Mac hands back', async () => {
    welcome(['agents.watchLive']);
    mockWatchLive.mockResolvedValue({
      url: 'https://mac.example.ts.net:47464/__mogbot-watch/t',
      expiresAt: 9,
    });
    await show();
    await act(async () => {
      fireEvent.press(screen.getByText('Watch live'));
    });
    expect(mockWatchLive).toHaveBeenCalledWith(agent().id, 'run1');
    expect(mockOpenHere).toHaveBeenCalledWith('https://mac.example.ts.net:47464/__mogbot-watch/t');
  });

  it('says why when the site isn’t running on the Mac', async () => {
    welcome(['agents.watchLive']);
    mockWatchLive.mockRejectedValue(
      new Error('Open Preview on the Mac first — the site isn’t running there.')
    );
    const onError = jest.fn();
    await show(tested, onError);
    await act(async () => {
      fireEvent.press(screen.getByText('Watch live'));
    });
    expect(mockOpenHere).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      'Open Preview on the Mac first — the site isn’t running there.'
    );
  });
});
