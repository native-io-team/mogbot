/**
 * What each agent can do, on the phone: the "Change … settings?" card's body
 * as the Mac sends it (generated fixtures), and "What it can do" — read-only,
 * with "Change in chat" that starts the request in the Chief's chat and
 * never sends anyone to Settings.
 */
import type { AgentMessage, AgentPolicyView } from '@shipstudio/companion-protocol';
import { chatDraft, settingsLines } from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// Reanimated's own mock needs its native module; these only need views and presets.
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
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
const mockCall = jest.fn();
jest.mock('../src/lib/session', () => ({ call: (...a: unknown[]) => mockCall(...a) }));
const mockSetComposer = jest.fn();
jest.mock('../src/lib/drafts', () => ({ setComposer: (...a: unknown[]) => mockSetComposer(...a) }));
const mockState = {
  link: { kind: 'connected' },
  welcome: { methods: ['agents.policy'], features: [] },
  overview: { agents: [{ id: 'chief', isMain: true }, { id: 'a1', isMain: false, pendingApprovals: 0 }] },
};
jest.mock('../src/lib/store', () => ({
  useApp: (select: (s: unknown) => unknown) => select(mockState),
  useServed: (m: string) => mockState.welcome.methods.includes(m),
}));

import { WhatItCanDo, policyDetail } from '../src/components/policy';
import { SettingsChange } from '../src/components/settingsChange';
import { PlanList } from '../src/components/planList';

const settingsCard = real.frames
  .flatMap((f) => (f.t === 'evt' && f.event.type === 'agents.message' ? [f.event.message] : []))
  .find((m) => m.approval?.settings) as AgentMessage;

describe('a settings card', () => {
  it('reads as the Mac wrote it: who, what changes, why, and that rules are words', async () => {
    const proposal = settingsCard.approval!.settings!;
    await render(<SettingsChange proposal={proposal} />);
    expect(screen.getByText('Hiring')).toBeTruthy();
    expect(screen.getByText('• Can now work in client-site (its own copy)')).toBeTruthy();
    expect(screen.getByText('• Can no longer use your browser')).toBeTruthy();
    expect(screen.getByText(/^Why: /)).toBeTruthy();
    expect(screen.getByText(/the app doesn’t stop it breaking one/)).toBeTruthy();
    expect(settingsLines(proposal)).toEqual([
      'Hiring: Can now work in client-site (its own copy). Can no longer use your browser.',
    ]);
  });
});

describe('a plan card', () => {
  it('lists every action as the Mac wrote it, numbered, with where and why', async () => {
    const planCard = real.frames
      .flatMap((f) => (f.t === 'evt' && f.event.type === 'agents.message' ? [f.event.message] : []))
      .find((m) => m.approval?.plan) as AgentMessage;
    expect(planCard.approval!.title).toBe('Do these under your name?');
    await render(<PlanList plan={planCard.approval!.plan!} />);
    expect(screen.getByText('1.')).toBeTruthy();
    expect(screen.getByText("Redeploy shippy's production on Vercel")).toBeTruthy();
    expect(screen.getByText('Open an issue about the failed build')).toBeTruthy();
    expect(screen.getByText('Comment on #12 with the fix')).toBeTruthy();
    expect(screen.getAllByText('julian/shippy')).toHaveLength(2);
    expect(screen.getByText(/^Why: /)).toBeTruthy();
  });
});

describe('What it can do', () => {
  beforeEach(() => {
    mockCall.mockReset().mockResolvedValue(real.agentsPolicy as AgentPolicyView);
    mockPush.mockReset();
    mockSetComposer.mockReset();
  });

  it('lists each setting with whose it is, and which are only instructions', async () => {
    await render(<WhatItCanDo agentId="a1" name="Finance" />);
    await screen.findByText('WHAT IT CAN DO');
    expect(mockCall).toHaveBeenCalledWith('agents.policy', { agentId: 'a1' });
    const lines = (real.agentsPolicy as AgentPolicyView).lines;
    expect(policyDetail(lines.find((l) => l.key === 'browser')!)).toBe('No · Its own');
    expect(policyDetail(lines.find((l) => l.key === 'independence')!)).toBe(
      'Use good judgement · Team default · instructions'
    );
    expect(screen.getByText(/except independence and rules/)).toBeTruthy();
    expect(screen.queryByText(/on your Mac|Settings/)).toBeNull();
  });

  it('“Change in chat” starts the request in the Chief’s chat, unsent', async () => {
    await render(<WhatItCanDo agentId="a1" name="Finance" />);
    await fireEvent.press(await screen.findByText('Change in chat'));
    expect(mockSetComposer).toHaveBeenCalledWith('chief', { text: chatDraft('Finance') });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/chat/[id]',
      params: { id: 'chief', compose: '1' },
    });
  });

  it('draws nothing for a Mac that doesn’t serve it', async () => {
    mockState.welcome.methods = [];
    await render(<WhatItCanDo agentId="a1" name="Finance" />);
    await waitFor(() => expect(screen.queryByText('WHAT IT CAN DO')).toBeNull());
    mockState.welcome.methods = ['agents.policy'];
  });
});
