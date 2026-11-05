import type { Approval, TeamSetupView } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import { TeamSetup } from '../src/components/TeamSetupCard';
import { cardOutcome } from '../src/lib/agents';
import { SET_ASIDE_NOTE, openStep, progress, sourceLine } from '../src/lib/teamSetup';

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
const calls: unknown[][] = [];
jest.mock('../src/lib/session', () => ({
  describeError: String,
  teamSetup: {
    step: (...a: unknown[]) => (calls.push(['step', ...a]), Promise.resolve(null)),
    routine: (...a: unknown[]) => (calls.push(['routine', ...a]), Promise.resolve(null)),
    hello: (...a: unknown[]) => (calls.push(['hello', ...a]), Promise.resolve({})),
    missing: () => (calls.push(['missing']), Promise.resolve({})),
    dismiss: () => (calls.push(['dismiss']), Promise.resolve(null)),
  },
}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { light: jest.fn(), select: jest.fn(), success: jest.fn(), error: jest.fn() },
}));
jest.mock('../src/components/agent', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { AgentAvatar: () => null, Spinner: () => <Text>spinner</Text> };
});

// The Mac's own answer, as `cargo test --lib companion::fixtures` serialized it:
// logins open, routines skipped, missing done, hello open with every state.
const fixture = real.agentsTeamSetup as TeamSetupView;
const view = (over: Partial<TeamSetupView> = {}): TeamSetupView => ({
  ...structuredClone(fixture),
  ...over,
});

function show(v: TeamSetupView, connected = true) {
  return render(
    <TeamSetup view={v} chief="Chief of Staff" connected={connected} onError={jest.fn()} />
  );
}

beforeEach(() => {
  calls.length = 0;
});

describe('Setting up your team', () => {
  it('says how far along it is and where it came from, never a count of requests', async () => {
    await show(view());
    expect(screen.getByText('Setting up your team')).toBeTruthy();
    expect(screen.getByText(progress(fixture))).toBeTruthy();
    expect(progress(fixture)).toBe('2 steps left');
    expect(screen.getByText(sourceLine(fixture))).toBeTruthy();
    expect(screen.getByText(SET_ASIDE_NOTE)).toBeTruthy();
    expect(SET_ASIDE_NOTE).not.toMatch(/\d/);
  });

  it('opens on the first open step, with Skip and the logins to add', async () => {
    await show(view());
    expect(openStep(fixture)).toBe('logins');
    // Named by the app, never the raw key; who uses it under it, quieter.
    expect(screen.getByText('Wise')).toBeTruthy();
    expect(screen.queryByText(/\bwise\b/)).toBeNull();
    expect(screen.getByText('Used by Finance')).toBeTruthy();
    expect(screen.getByText('Add')).toBeTruthy();
    await fireEvent.press(screen.getByText('Skip'));
    expect(calls).toEqual([['step', 'logins', 'skipped']]);
  });

  it('shows a skipped step folded, and offers to open it again', async () => {
    await show(view());
    expect(screen.getByText('Skipped')).toBeTruthy();
    await fireEvent.press(screen.getByText('Switch on routines'));
    expect(screen.getByText('Ops · Every weekday at 09:00')).toBeTruthy();
    await fireEvent.press(screen.getByText('Open again'));
    await waitFor(() => expect(calls).toEqual([['step', 'routines', 'open']]));
  });

  it('holds every Say hi while one agent is still replying', async () => {
    await show(view());
    await fireEvent.press(screen.getByText('Say hi to your team'));
    expect(screen.getByText('Replying…')).toBeTruthy();
    expect(screen.getByText('Said hi')).toBeTruthy();
    const hi = screen.getByRole('button', { name: 'Say hi' });
    expect(hi.props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('says hi to one agent when nobody is replying', async () => {
    const v = view();
    const hello = v.steps.find((s) => s.id === 'hello')!;
    hello.agents = hello.agents!.map((a) =>
      a.state === 'working' ? { ...a, state: 'said_hi' } : a
    );
    await show(v);
    await fireEvent.press(screen.getByText('Say hi to your team'));
    await fireEvent.press(screen.getByRole('button', { name: 'Say hi' }));
    await waitFor(() => expect(calls).toEqual([['hello', hello.agents![0].agentId]]));
  });

  it('hands what they are missing to the Chief in one go', async () => {
    const v = view();
    v.steps.find((s) => s.id === 'missing')!.state = 'open';
    await show(v);
    await fireEvent.press(screen.getByText('What they’re missing'));
    await fireEvent.press(screen.getByText('Ask Chief of Staff to sort these'));
    await waitFor(() => expect(calls).toEqual([['missing']]));
  });

  it('is one quiet line once everything is done', async () => {
    await show(view({ complete: true, done: 4 }));
    expect(screen.queryByText('Setting up your team')).toBeNull();
    expect(screen.getByLabelText('Done. Your team is set up.')).toBeTruthy();
  });

  it('keeps its answers drawn and disabled while the Mac is away', async () => {
    await show(view(), false);
    expect(screen.getByRole('button', { name: 'Skip' }).props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });
});

describe('a request the Mac set aside', () => {
  it('reads as set aside, with why and that nothing ran', async () => {
    const approval = (real.agentsMessages.messages as { approval?: Approval }[]).find(
      (m) => m.approval?.setAside
    )!.approval!;
    expect(cardOutcome(approval)).toBe(
      'Set aside · This came from Chief of Staff checking in with every agent after the import. Nothing ran.'
    );
  });
});
