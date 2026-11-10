/**
 * "Carry on with Codex until then?" on the phone (desktop
 * `agents/crossover.rs`, `AgentCrossoverCard`): the desk's three answers,
 * never a plain Allow / Deny. Wait is Deny, Just this time is Allow, and
 * Always is Allow with `always`, exactly as the desk sends them; the receipt
 * is the desk's line.
 */

import type { AgentMessage, Approval } from '@shipstudio/companion-protocol';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ARM_MS, ApprovalCard } from '../src/components/ApprovalCard';
import { cardOutcome } from '../src/lib/agents';
import { askAction } from '../src/lib/catchUp';
import { setApp } from '../src/lib/store';
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
jest.mock('expo-router', () => ({ useIsFocused: () => true }));
jest.mock('../src/lib/haptics', () => ({
  haptic: {
    light: jest.fn(),
    select: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));
const mockAnswer = jest.fn((..._a: unknown[]) => Promise.resolve(null));
jest.mock('../src/lib/session', () => ({
  answerApproval: (...a: unknown[]) => mockAnswer(...a),
  call: jest.fn(),
  describeError: String,
}));

const SUMMARY =
  "Codex can't open Claude Code's conversation, so Finance starts there from your chat and its memory.";

const card = (over: Partial<Approval> = {}): Approval => ({
  requestId: 'req_x',
  title: 'Your Claude Code account is out until 4:00 PM. Carry on with Codex until then?',
  detail: '',
  summary: SUMMARY,
  status: 'pending',
  crossover: { from: 'claude', to: 'codex', until: 1, resume: true },
  ...over,
});
const message = (approval: Approval): AgentMessage => ({
  id: 'm1',
  agentId: 'fin',
  ts: 1,
  kind: 'approval',
  text: '',
  approval,
});

beforeEach(() => {
  jest.useFakeTimers();
  mockAnswer.mockClear();
  setApp({ link: { kind: 'connected' } as never });
});

async function show(a = card()) {
  await render(
    <ApprovalCard
      message={message(a)}
      approval={a}
      agent={agent({ id: 'fin' })}
      onError={() => {}}
    />
  );
  await act(() => jest.advanceTimersByTime(ARM_MS + 50));
}

it('offers Wait, Just this time and Always, never Allow, Deny or ⋯', async () => {
  await show();
  expect(screen.getByText(SUMMARY)).toBeTruthy();
  expect(screen.getByText('Wait')).toBeTruthy();
  expect(screen.getByText('Just this time')).toBeTruthy();
  expect(screen.getByText('Always')).toBeTruthy();
  expect(screen.queryByText('Allow')).toBeNull();
  expect(screen.queryByText('Deny')).toBeNull();
  expect(screen.queryByLabelText('More answers')).toBeNull();
});

it.each([
  ['Wait', false, false],
  ['Just this time', true, false],
  ['Always', true, true],
])('%s goes to the Mac as the desk sends it', async (word, allow, always) => {
  await show();
  await fireEvent.press(screen.getByText(word));
  expect(mockAnswer).toHaveBeenCalledWith('fin', 'req_x', allow, always, undefined);
});

it('Catch up opens it, and the receipt is the desk’s line', () => {
  expect(askAction(message(card()))).toEqual({ kind: 'open', label: 'Answer' });
  expect(cardOutcome(card({ status: 'allowed', choice: 'Always' }))).toBe(
    'Always · carrying on with Codex whenever Claude Code is out'
  );
  expect(cardOutcome(card({ status: 'allowed', choice: 'Just this time' }))).toBe(
    'Just this time · carrying on with Codex'
  );
  expect(cardOutcome(card({ status: 'denied', choice: 'Wait' }))).toBe(
    'Waiting · back when Claude Code refills'
  );
});
