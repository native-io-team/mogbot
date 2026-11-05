/**
 * Onboarding's key states: a machine with an engine ready goes straight to
 * the hand-off; a fresh one sees the engine cards, each saying what pressing
 * it does; force mode always shows the pick; a card for an engine that isn't
 * ready opens its install → sign-in steps; a failed check offers a retry.
 * Between a ready engine and the hand-off, one question: how much agents do
 * on their own (Skip keeps the default).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SetupItem } from '../../../lib/setup';

const getFullSetupStatus = vi.hoisted(() => vi.fn());
const setDefaultAgentId = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/setup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/setup')>();
  return { ...actual, getFullSetupStatus, setDefaultAgentId };
});
const getOnboardingTestMode = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/agentOnboarding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/agentOnboarding')>();
  return { ...actual, getOnboardingTestMode };
});
vi.mock('../../../lib/analytics', () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
  setActiveScreen: vi.fn(),
}));
vi.mock('../CelebrationScreen', () => ({
  CelebrationScreen: ({ engineName }: { engineName: string | null }) => (
    <div data-testid="handoff">{engineName}</div>
  ),
}));
vi.mock('../OnboardingTerminal', () => ({ OnboardingTerminal: () => null }));
const getIndependence = vi.hoisted(() => vi.fn());
const setIndependence = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/agentIndependence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/agentIndependence')>();
  return { ...actual, getIndependence, setIndependence };
});

import { AgentOnboardingScreen } from './AgentOnboardingScreen';

/** The engine card with this name (cards are list items, named by their text). */
async function card(name: string): Promise<HTMLElement> {
  const label = await screen.findByText(name, { selector: '.agent-pick-card-name' });
  return label.closest('button') as HTMLElement;
}

/** The independence question, answered by skipping it. */
async function skipIndependence() {
  expect(
    await screen.findByRole('heading', { name: 'How much should your agents do on their own?' })
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
}

const item = (id: string, status: SetupItem['status']): SetupItem => ({
  id,
  friendlyName: id,
  status,
});
const machine = (over: Record<string, SetupItem['status']> = {}) => ({
  allReady: false,
  items: ['homebrew', 'node', 'claude', 'claude_auth', 'codex', 'codex_auth'].map((id) =>
    item(id, over[id] ?? 'not_installed')
  ),
});

describe('AgentOnboardingScreen', () => {
  beforeEach(() => {
    getFullSetupStatus.mockReset();
    setDefaultAgentId.mockReset().mockResolvedValue(undefined);
    getOnboardingTestMode.mockReset().mockResolvedValue({ mock: false, forceOnboarding: false });
    getIndependence.mockReset().mockResolvedValue('judgement');
    setIndependence.mockReset().mockImplementation(async (level: string) => level);
  });

  it('goes straight to the hand-off when an engine is already ready', async () => {
    getFullSetupStatus.mockResolvedValue(machine({ codex: 'ready', codex_auth: 'ready' }));
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    await skipIndependence();
    expect(await screen.findByTestId('handoff')).toHaveTextContent('Codex');
    expect(setDefaultAgentId).toHaveBeenCalledWith('codex');
    // Skipped: nothing saved, so the default stands.
    expect(setIndependence).not.toHaveBeenCalled();
  });

  it('asks how much agents do on their own, defaulting to good judgement', async () => {
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready', claude_auth: 'ready' }));
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    await screen.findByRole('heading', { name: 'How much should your agents do on their own?' });
    expect(screen.queryByTestId('handoff')).not.toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Check with me often'),
      expect.stringContaining('Use good judgement'),
      expect.stringContaining('Go hard — get it done'),
    ]);
    expect(screen.getByRole('radio', { name: /Use good judgement/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    // Honest about what never changes.
    expect(
      screen.getByText(
        'You’ll always be asked before anything that spends money, sends as you, or deletes.'
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Go hard/ }));
    expect(screen.getByRole('radio', { name: /Go hard/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('handoff')).toHaveTextContent('Claude Code');
    expect(setIndependence).toHaveBeenCalledWith('go_hard');
  });

  it('a choice that doesn’t save says so and stays, with Skip still there', async () => {
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready', claude_auth: 'ready' }));
    setIndependence.mockRejectedValue({ type: 'Other', message: 'Disk full' });
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    await screen.findByRole('heading', { name: 'How much should your agents do on their own?' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full');
    expect(screen.queryByTestId('handoff')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByTestId('handoff')).toBeInTheDocument();
  });

  it('a fresh machine sees one line on how it works and two actionable cards', async () => {
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready' }));
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    expect(await screen.findByText('Your own team of AI agents')).toBeInTheDocument();
    expect(
      screen.getByText(/Talk to your Chief of Staff\. It builds a team\./)
    ).toBeInTheDocument();
    expect(await card('Claude Code')).toHaveTextContent('Sign in');
    expect(await card('Codex')).toHaveTextContent('Install & sign in');
  });

  it('force mode shows the pick even with an engine ready; its card finishes', async () => {
    getOnboardingTestMode.mockResolvedValue({ mock: false, forceOnboarding: true });
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready', claude_auth: 'ready' }));
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    const claude = await card('Claude Code');
    expect(claude).toHaveTextContent('Ready');
    fireEvent.click(claude);
    await skipIndependence();
    expect(await screen.findByTestId('handoff')).toHaveTextContent('Claude Code');
  });

  it('a card for an engine that isn’t ready opens its setup steps', async () => {
    getFullSetupStatus.mockResolvedValue(machine());
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    fireEvent.click(await card('Claude Code'));
    expect(await screen.findByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.queryByTestId('handoff')).not.toBeInTheDocument();
    // The way back is there (held while its first step starts on its own).
    expect(screen.getByRole('button', { name: /Choose a different one/ })).toBeInTheDocument();
  });

  it('a failed check offers a retry instead of guessing', async () => {
    getFullSetupStatus.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(machine());
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    expect(await screen.findByText('Couldn’t check this Mac. Try again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.queryByText('Couldn’t check this Mac. Try again.')).not.toBeInTheDocument()
    );
  });
});
