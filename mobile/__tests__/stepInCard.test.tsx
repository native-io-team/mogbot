/**
 * "Needs you in its browser" on the phone (desktop `agents/step_in.rs`):
 * on a Mac that lets the phone into the tab (`stepIn.phone`), Step in opens
 * the sign-in screen on the agent's own tab; on an older Mac Step in happens
 * only there, so the card offers Not now and says where to go. Never an
 * Allow (the Mac refuses one with "Step in on your Mac"). While the user is
 * in the tab, here or at the Mac, it offers nothing.
 */

import type { AgentMessage, Approval } from '@shipstudio/companion-protocol';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ARM_MS, ApprovalCard } from '../src/components/ApprovalCard';
import {
  STEP_IN_AT_MAC,
  STEP_IN_FROM_HERE,
  STEP_IN_ON_YOUR_MAC,
  cardOutcome,
  stepInOnPhone,
} from '../src/lib/agents';
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
// The loops ask whether their screen is showing (lib/moving.ts).
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  router: { push: (...a: unknown[]) => mockPush(...a) },
}));
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

const stepIn = (over: Partial<NonNullable<Approval['stepIn']>> = {}): Approval => ({
  requestId: 'req_stepin',
  title: 'Browser Helper needs you in its browser',
  detail: 'The portal asks for a code sent to your phone.',
  status: 'pending',
  stepIn: {
    reason: 'The portal asks for a code sent to your phone.',
    site: 'portal.northwind.example',
    url: 'https://portal.northwind.example/login/verify',
    tab: 2,
    ...over,
  },
});
const message = (approval: Approval): AgentMessage => ({
  id: 'm1',
  agentId: 'browse',
  ts: 1,
  kind: 'approval',
  text: '',
  approval,
});

beforeEach(() => {
  jest.useFakeTimers();
  mockAnswer.mockClear();
  mockPush.mockClear();
  setApp({ link: { kind: 'connected' } as never, welcome: null });
});

it('on a Mac that lets the phone in, Step in opens the agent’s tab here', async () => {
  setApp({
    welcome: { methods: ['agents.stepInBegin'], features: ['stepIn.phone'] } as never,
  });
  const a = stepIn();
  await render(
    <ApprovalCard
      message={message(a)}
      approval={a}
      agent={agent({ id: 'browse' })}
      onError={() => {}}
    />
  );
  await act(() => jest.advanceTimersByTime(ARM_MS + 50));
  expect(screen.getByText(STEP_IN_FROM_HERE)).toBeTruthy();
  expect(screen.queryByText('Allow')).toBeNull();
  await fireEvent.press(screen.getByText('Step in'));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/signin',
    params: { agentId: 'browse', requestId: 'req_stepin', stepIn: '1' },
  });
  // Step in answers nothing by itself: the Mac holds the tab when the screen asks.
  expect(mockAnswer).not.toHaveBeenCalled();
});

it('while a phone is in the tab, it names the phone and offers nothing', async () => {
  const a = stepIn({ inSince: 1, until: 2, onPhone: 'Sam’s iPhone' });
  await render(
    <ApprovalCard
      message={message(a)}
      approval={a}
      agent={agent({ id: 'browse' })}
      onError={() => {}}
    />
  );
  await act(() => jest.advanceTimersByTime(ARM_MS + 50));
  expect(screen.getByText(stepInOnPhone('Sam’s iPhone'))).toBeTruthy();
  expect(screen.queryByText('Step in')).toBeNull();
  expect(screen.queryByText('Not now')).toBeNull();
});

it('offers Not now and says Step in is on the Mac; never an Allow', async () => {
  const a = stepIn();
  await render(
    <ApprovalCard
      message={message(a)}
      approval={a}
      agent={agent({ id: 'browse' })}
      onError={() => {}}
    />
  );
  await act(() => jest.advanceTimersByTime(ARM_MS + 50));
  expect(screen.getByText(STEP_IN_ON_YOUR_MAC)).toBeTruthy();
  // Where, as the desk's card says it; the Mac's "opens on this Mac" detail isn't repeated.
  expect(screen.getByText('portal.northwind.example')).toBeTruthy();
  expect(screen.queryByText('The portal asks for a code sent to your phone.')).toBeNull();
  expect(screen.queryByText('Allow')).toBeNull();
  expect(screen.queryByText('Step in')).toBeNull();
  await fireEvent.press(screen.getByText('Not now'));
  expect(mockAnswer).toHaveBeenCalledWith('browse', 'req_stepin', false, false, undefined);
});

it('while the user is in the tab at the Mac, it offers nothing and says so', async () => {
  const a = stepIn({ inSince: 1, until: 2 });
  await render(
    <ApprovalCard
      message={message(a)}
      approval={a}
      agent={agent({ id: 'browse' })}
      onError={() => {}}
    />
  );
  await act(() => jest.advanceTimersByTime(ARM_MS + 50));
  expect(screen.getByText(STEP_IN_AT_MAC)).toBeTruthy();
  expect(screen.queryByText('Not now')).toBeNull();
});

it('Catch up opens it rather than answering, and the receipt uses the desk’s words', () => {
  expect(askAction(message(stepIn()))).toEqual({ kind: 'open', label: 'Open' });
  expect(cardOutcome({ ...stepIn(), status: 'denied' })).toBe('Not now');
  expect(cardOutcome({ ...stepIn(), status: 'allowed' })).toBe('Handed back');
});
