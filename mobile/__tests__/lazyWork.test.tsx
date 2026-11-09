/**
 * A finished turn's "What it did" on a page that left its steps out
 * (`stepsOmitted`): nothing is read while it's folded, its own steps are
 * read once when it opens, and a page from an older Mac (steps inline) opens
 * without asking for anything.
 */

import type { AgentMessage, TurnWork, WelcomeFrame } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { WorkLine } from '../src/components/work';
import { setApp } from '../src/lib/store';
import { resetTurnStepsForTests } from '../src/lib/turnSteps';

const mockCall = jest.fn<Promise<unknown>, [string, unknown]>();
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  preset.duration = () => preset;
  return { __esModule: true, default: { View }, FadeIn: preset };
});
jest.mock('../src/components/TypingDots', () => ({ TypingDots: () => null }));
jest.mock('../src/components/attachments', () => ({ Attachments: () => null }));
jest.mock('../src/components/Shimmer', () => ({
  Shimmer: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/components/AgentKey', () => ({ AgentKey: () => null }));
jest.mock('expo-haptics', () => ({}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { light: jest.fn(), select: jest.fn(), success: jest.fn(), error: jest.fn() },
}));
jest.mock('../src/lib/session', () => ({
  describeError: String,
  call: (method: string, params: unknown) => mockCall(method, params),
  canCall: (method: string) =>
    jest
      .requireActual<typeof import('../src/lib/store')>('../src/lib/store')
      .getApp()
      .welcome?.methods.includes(method as never) ?? false,
  stop: jest.fn(() => Promise.resolve(true)),
}));

const full: TurnWork = {
  startedAt: 0,
  endedAt: 6 * 60_000,
  stepCount: 2,
  fileCount: 1,
  files: ['Hero.tsx'],
  steps: [
    { at: 2_000, kind: 'read', label: 'Read Hero.tsx' },
    { at: 40_000, kind: 'edit', label: 'Edited Hero.tsx' },
  ],
};
const folded: TurnWork = { ...full, steps: [], stepsOmitted: true };
const reply = (work: TurnWork): AgentMessage => ({
  id: 'r1',
  agentId: 'acme',
  ts: 6 * 60_000,
  kind: 'agent',
  text: 'Done',
  work,
});

beforeEach(() => {
  mockCall.mockReset();
  resetTurnStepsForTests();
  setApp({ welcome: { methods: ['agents.workSteps'], features: [] } as unknown as WelcomeFrame });
});

it('reads its own steps once, when it first opens', async () => {
  mockCall.mockResolvedValue({ work: full });
  const m = reply(folded);
  await render(<WorkLine message={m} work={folded} onError={jest.fn()} />);
  expect(mockCall).not.toHaveBeenCalled();
  const toggle = screen.getByRole('button', { name: /2 steps/ });
  await fireEvent.press(toggle);
  expect(await screen.findByText('Read Hero.tsx')).toBeTruthy();
  expect(screen.queryByText(/earlier steps/)).toBeNull();
  expect(mockCall).toHaveBeenCalledWith('agents.workSteps', { agentId: 'acme', messageId: 'r1' });
  await fireEvent.press(toggle);
  await fireEvent.press(toggle);
  expect(mockCall).toHaveBeenCalledTimes(1);
});

it('opens a timeline that came with its steps without asking', async () => {
  const m = reply(full);
  await render(<WorkLine message={m} work={full} onError={jest.fn()} />);
  await fireEvent.press(screen.getByRole('button', { name: /2 steps/ }));
  expect(screen.getByText('Read Hero.tsx')).toBeTruthy();
  expect(mockCall).not.toHaveBeenCalled();
});

it('says when it couldn’t read them, and tries again', async () => {
  mockCall.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ work: null });
  await render(<WorkLine message={reply(folded)} work={folded} onError={jest.fn()} />);
  await fireEvent.press(screen.getByRole('button', { name: /2 steps/ }));
  expect(await screen.findByText('Couldn’t read the steps.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Its steps are no longer kept.')).toBeTruthy();
});
