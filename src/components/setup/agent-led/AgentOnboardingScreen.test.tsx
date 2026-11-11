/**
 * Onboarding as one line of one-question screens: Welcome, then the engine
 * (a screen per install / sign-in), then straight into the Chief's chat.
 * Nothing else is asked here: the import, the phone, another account and
 * independence each wait for their moment in the app. Each screen has one
 * big button and Back; the step is saved, so a relaunch resumes it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SetupItem } from '../../../lib/setup';
import { FLOW_STORAGE_KEY, saveProgress } from '../../../lib/onboardingFlow';

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
vi.mock('../OnboardingTerminal', () => ({ OnboardingTerminal: () => null }));
import { AgentOnboardingScreen } from './AgentOnboardingScreen';

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

const heading = (name: string | RegExp) => screen.findByRole('heading', { name });
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

describe('AgentOnboardingScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    getFullSetupStatus.mockReset();
    setDefaultAgentId.mockReset().mockResolvedValue(undefined);
    getOnboardingTestMode.mockReset().mockResolvedValue({ mock: false, forceOnboarding: false });
  });

  it('walks Welcome and the engine, then hands off to the Chief, where the rest happens', async () => {
    getFullSetupStatus.mockResolvedValue(machine({ codex: 'ready', codex_auth: 'ready' }));
    const onComplete = vi.fn();
    render(<AgentOnboardingScreen onComplete={onComplete} />);

    expect(await heading('Your own team of AI agents')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    // Keyboard first: the big button has focus, so Enter starts.
    expect(screen.getByRole('button', { name: 'Get started' })).toHaveFocus();
    press('Get started');

    // Already set up here: "Done", and one button, focused.
    expect(await heading('Codex is connected')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Done.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus());
    press('Continue');
    await waitFor(() => expect(setDefaultAgentId).toHaveBeenCalledWith('codex'));

    // Bringing agents over and the phone happen in the Chief's chat now.
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(JSON.parse(localStorage.getItem(FLOW_STORAGE_KEY) ?? '{}')).toMatchObject({
      finished: true,
    });
  });

  it('saves each step, and Back goes one screen back', async () => {
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready', claude_auth: 'ready' }));
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    await screen.findByRole('button', { name: 'Get started' });
    press('Get started');
    expect(await heading('Claude Code is connected')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(FLOW_STORAGE_KEY) ?? '{}')).toMatchObject({
      step: 'engine',
    });
    press('Back');
    expect(await heading('Your own team of AI agents')).toBeInTheDocument();
  });

  it('a relaunch opens where it stopped', async () => {
    saveProgress('engine');
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready', claude_auth: 'ready' }));
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    expect(await heading('Claude Code is connected')).toBeInTheDocument();
  });

  it('a relaunch saved on a screen that is no longer here counts as finished', async () => {
    localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify({ v: 1, step: 'phonePair' }));
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready', claude_auth: 'ready' }));
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    // Shown only if onboarding is opened anyway: it starts at the top.
    expect(await heading('Your own team of AI agents')).toBeInTheDocument();
  });

  it('a fresh machine picks an engine, then sees one screen for its first step', async () => {
    saveProgress('engine');
    getFullSetupStatus.mockResolvedValue(machine());
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    await heading('Which AI should your agents run on?');
    const claude = screen.getByText('Claude Code', { selector: '.agent-pick-card-name' });
    expect(screen.getByText('Codex', { selector: '.agent-pick-card-name' })).toBeInTheDocument();
    // Said for people who don't code: the name "Code" isn't a requirement,
    // and each card names the plan it needs.
    expect(screen.getByText(/You don’t need to know how to code\./)).toBeInTheDocument();
    expect(screen.getByText('Needs a Claude Pro or Max plan')).toBeInTheDocument();
    expect(screen.getByText('Needs a ChatGPT Plus or Pro plan')).toBeInTheDocument();
    expect(screen.getAllByText(/not only code/)).toHaveLength(2);
    fireEvent.click(claude.closest('button') as HTMLElement);
    expect(await heading('Install Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Claude Code · 1 of 2')).toBeInTheDocument();
  });

  it('force mode shows the choice even with an engine ready; its card goes on to the Chief', async () => {
    saveProgress('engine');
    getOnboardingTestMode.mockResolvedValue({ mock: false, forceOnboarding: true });
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready', claude_auth: 'ready' }));
    const onComplete = vi.fn();
    render(<AgentOnboardingScreen onComplete={onComplete} />);
    await heading('Which AI should your agents run on?');
    fireEvent.click(
      screen.getByText('Claude Code', { selector: '.agent-pick-card-name' }).closest('button')!
    );
    await waitFor(() => expect(setDefaultAgentId).toHaveBeenCalledWith('claude-code'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('a failed status check offers a retry instead of guessing', async () => {
    getFullSetupStatus.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(machine());
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    expect(await screen.findByText(/Couldn’t check this Mac\./)).toBeInTheDocument();
    press('Check again');
    await waitFor(() =>
      expect(screen.queryByText(/Couldn’t check this Mac\./)).not.toBeInTheDocument()
    );
  });
});
