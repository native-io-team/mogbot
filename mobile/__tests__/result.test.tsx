import type { AgentMessage, ResultCard, WelcomeFrame } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import { offlineNote } from '../src/components/surfaces';
import { ResultCardView, useCanRevise } from '../src/components/result';
import { EMPTY_DRAFT, putDraft } from '../src/lib/drafts';
import { useApp } from '../src/lib/store';
import { agent } from './helpers';

// Reanimated's own mock needs its native module; the card shares only the card styles.
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
jest.mock('../src/lib/session', () => ({
  answerApproval: jest.fn(),
  describeError: String,
}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { light: jest.fn(), select: jest.fn(), success: jest.fn(), error: jest.fn() },
}));
// The card's files are the chat's own attachment tiles, tested with the chat.
jest.mock('../src/components/attachments', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Attachments: ({ attachments }: { attachments: { name: string }[] }) => (
      <Text>{attachments.map((a) => a.name).join(', ')}</Text>
    ),
  };
});

// The Mac's own messages, as `cargo test --lib companion::fixtures` serialized them.
const messages = real.agentsMessages.messages as AgentMessage[];
const byId = (id: string) => messages.find((m) => m.id === id)!;
const v1 = byId('m26');
const v2 = byId('m28');

const welcome = (features?: string[]) =>
  useApp.setState({
    link: { kind: 'connected', route: 'tailscale' } as never,
    welcome: {
      methods: ['agents.send'],
      ...(features ? { features } : {}),
    } as unknown as WelcomeFrame,
  });

function show(message: AgentMessage, over: Partial<Parameters<typeof ResultCardView>[0]> = {}) {
  return render(
    <ResultCardView
      message={message}
      card={message.result as ResultCard}
      agent={agent()}
      newest
      onError={jest.fn()}
      {...over}
    />
  );
}

describe('the result card on the phone', () => {
  it('offline keeps Ask for changes, disabled, with the note every card uses', async () => {
    useApp.setState({ link: { kind: 'reconnecting', attempt: 1, lastSeenAt: 0 } as never });
    const ask = jest.fn();
    await show(v1, { onAskForChanges: ask });
    await fireEvent.press(screen.getByText('Ask for changes'));
    expect(ask).not.toHaveBeenCalled();
    expect(screen.getByText(offlineNote())).toBeTruthy();
  });

  it('reads the Mac’s card: the work, then one Checks box with what it didn’t verify', async () => {
    const ask = jest.fn();
    useApp.setState({ link: { kind: 'connected', route: 'tailscale' } as never });
    await show(v1, { onAskForChanges: ask });
    expect(screen.getByText('October invoice summary')).toBeTruthy();
    expect(screen.getByText('Not verified')).toBeTruthy();
    expect(screen.getByText(/today's rate/)).toBeTruthy();
    expect(screen.getByText('october-invoices.pdf')).toBeTruthy();
    expect(screen.getByLabelText('Open Source sheet')).toBeTruthy();
    // The agent's claim, attributed, with a neutral bullet rather than a tick.
    expect(screen.getByText('It says it checked')).toBeTruthy();
    expect(screen.queryByText('Checked')).toBeNull();
    expect(screen.getByText('• Totals match the bank export')).toBeTruthy();
    await fireEvent.press(screen.getByText('Ask for changes'));
    expect(ask).toHaveBeenCalledWith({
      id: 'res-oct',
      version: 1,
      title: 'October invoice summary',
    });
  });

  it('shows version 2 with what changed, and a before and after', async () => {
    await show(v2);
    expect(screen.getByText('v2')).toBeTruthy();
    // What changed, as its own block above the summary: a heading and the agent's line.
    expect(screen.getByText('Changes since v1')).toBeTruthy();
    expect(screen.getByText("EUR invoices use the rate on each invoice's date")).toBeTruthy();
    expect(
      screen.getByLabelText("Changes since v1: EUR invoices use the rate on each invoice's date")
    ).toBeTruthy();
    // One page, both sides: the compare, captioned.
    expect(screen.getByText('Before · After')).toBeTruthy();
    // The agent listed nothing it didn't verify this time: no box.
    expect(screen.queryByText('Not verified')).toBeNull();
    expect(screen.queryByText('Ask for changes')).toBeNull();
  });

  it('puts the checks after the work, the claims above the caveats', async () => {
    await show(v1);
    const text = JSON.stringify(screen.toJSON());
    const link = text.indexOf('Source sheet');
    const checked = text.indexOf('It says it checked');
    const unverified = text.indexOf('Not verified');
    expect(link).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(link);
    expect(unverified).toBeGreaterThan(checked);
  });

  it('folds an older version to a line', async () => {
    await show(v1, { newest: false, onAskForChanges: jest.fn() });
    expect(screen.getByText('October invoice summary · v1 · earlier version')).toBeTruthy();
    expect(screen.queryByText('Not verified')).toBeNull();
    await fireEvent.press(screen.getByText(/earlier version/));
    expect(screen.getByText('Not verified')).toBeTruthy();
    // An earlier version is for reading: it can't be revised.
    expect(screen.queryByText('Ask for changes')).toBeNull();
  });

  it('offers Ask for changes only to a Mac that takes it', async () => {
    function Probe() {
      return <Text>{useCanRevise() ? 'can revise' : 'cannot revise'}</Text>;
    }
    welcome();
    await render(<Probe />);
    expect(screen.getByText('cannot revise')).toBeTruthy();
    welcome(['results.revise']);
    await render(<Probe />);
    expect(screen.getByText('can revise')).toBeTruthy();
  });
});

describe('asking for changes', () => {
  it('waits in the draft, and counts as something to keep', () => {
    const ref = { id: 'res-oct', version: 1, title: 'October invoice summary' };
    const drafts = putDraft({}, 'a', { revising: ref });
    expect(drafts.a).toEqual({ ...EMPTY_DRAFT, revising: ref });
    expect(putDraft(drafts, 'a', { revising: undefined })).toEqual({});
  });
});
