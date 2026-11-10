/**
 * "Save … as a skill?" on the phone (`agents/skills_learn.rs`): the skill as
 * it would be saved, Not now / Save, and the desk's receipt once answered.
 */

import type { AgentMessage, Approval } from '@shipstudio/companion-protocol';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ARM_MS, ApprovalCard } from '../src/components/ApprovalCard';
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
jest.mock('../src/lib/session', () => ({
  answerApproval: jest.fn(() => Promise.resolve(null)),
  call: jest.fn(),
  describeError: String,
}));


const card: Approval = {
  requestId: 'req_skill',
  title: 'Save “Export invoices” as a skill?',
  detail: '1. Open Reports\n2. Export as CSV',
  summary: 'When to use it: When asked for invoices',
  status: 'pending',
  risk: 'low',
  skill: {
    slug: 'export-invoices',
    name: 'Export invoices',
    when: 'When asked for invoices',
    steps: '1. Open Reports\n2. Export as CSV',
    removed: 2,
  },
};
const message = (approval: Approval): AgentMessage => ({
  id: 'm-skill',
  agentId: 'temp',
  ts: 1,
  kind: 'approval',
  text: '',
  approval,
});

beforeEach(() => {
  jest.useFakeTimers();
  setApp({ link: { kind: 'connected' } as never });
});

const show = async (a: Approval) => {
  await render(
    <ApprovalCard message={message(a)} approval={a} agent={agent({ id: 'temp' })} onError={() => {}} />
  );
  await act(() => jest.advanceTimersByTime(ARM_MS + 50));
};

it('previews the skill and answers Not now / Save, with nothing behind ⋯', async () => {
  await show(card);
  expect(screen.getByText(/When asked for invoices/)).toBeTruthy();
  expect(screen.getByText(/2\. Export as CSV/)).toBeTruthy();
  expect(screen.getByText('2 personal details or secrets removed.')).toBeTruthy();
  expect(screen.getByText('Save')).toBeTruthy();
  expect(screen.getByText('Not now')).toBeTruthy();
  expect(screen.queryByText('Allow')).toBeNull();
  expect(screen.queryByLabelText('More answers')).toBeNull();
});

it('shows every step: a long skill folds behind Show all steps, outside any scroll box', async () => {
  const steps = Array.from({ length: 12 }, (_, i) => `${i + 1}. Step number ${i + 1}`).join('\n');
  await show({ ...card, detail: steps, skill: { ...card.skill!, steps } });
  expect(screen.getByText(/8\. Step number 8/)).toBeTruthy();
  expect(screen.queryByText(/12\. Step number 12/)).toBeNull();
  // Not inside the card's fitted scroll area, which cut the steps off.
  expect(JSON.stringify(screen.toJSON())).not.toContain('RCTScrollView');
  await fireEvent.press(screen.getByLabelText('Show all steps'));
  expect(screen.getByText(/12\. Step number 12/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Show fewer steps'));
  expect(screen.queryByText(/12\. Step number 12/)).toBeNull();
});

it('a short skill shows all its steps with no toggle', async () => {
  await show(card);
  expect(screen.queryByLabelText('Show all steps')).toBeNull();
});

it('reads as a receipt once saved', async () => {
  await show({ ...card, status: 'allowed' });
  expect(screen.getByLabelText('Saved. Save “Export invoices” as a skill?')).toBeTruthy();
});
