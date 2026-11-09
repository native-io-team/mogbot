/**
 * Onboarding as one line of one-question screens: Welcome, the engine (a
 * screen per install / sign-in), independence, the phone (skippable), and
 * "You're ready: bring your agents, or start fresh?". Each screen has one
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
const getIndependence = vi.hoisted(() => vi.fn());
const setIndependence = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/agentIndependence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/agentIndependence')>();
  return { ...actual, getIndependence, setIndependence };
});
const setImportChoice = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/agents')>();
  return { ...actual, setImportChoice };
});
const getPhoneStatus = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/companion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/companion')>();
  return { ...actual, getPhoneStatus };
});

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
    getIndependence.mockReset().mockResolvedValue('judgement');
    setIndependence.mockReset().mockImplementation((level: string) => Promise.resolve(level));
    setImportChoice.mockReset().mockResolvedValue('declined');
    getPhoneStatus.mockReset().mockResolvedValue({
      enabled: false,
      devices: [],
      tailscale: { state: 'notInstalled' },
    });
  });

  it('walks one screen at a time to the end, and Start fresh hands off', async () => {
    getFullSetupStatus.mockResolvedValue(machine({ codex: 'ready', codex_auth: 'ready' }));
    const onComplete = vi.fn();
    render(<AgentOnboardingScreen onComplete={onComplete} />);

    expect(await heading('Your own team of AI agents')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    press('Get started');

    // Already set up here: "Done", and one button.
    expect(await heading('Codex is connected')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Done.');
    press('Continue');
    await waitFor(() => expect(setDefaultAgentId).toHaveBeenCalledWith('codex'));

    expect(await heading('How much should your agents do on their own?')).toBeInTheDocument();
    press('Skip');
    expect(setIndependence).not.toHaveBeenCalled();

    expect(await heading('Use your agents from your phone?')).toBeInTheDocument();
    press('Skip for now');

    expect(await heading('You’re ready')).toBeInTheDocument();
    expect(screen.getByText(/bring your agents from Grok, ChatGPT/)).toBeInTheDocument();
    press('Start fresh');
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(setImportChoice).toHaveBeenCalledWith('declined');
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
    saveProgress('ready');
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready', claude_auth: 'ready' }));
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    expect(await heading('You’re ready')).toBeInTheDocument();
    expect(screen.getByText(/Claude Code is connected/)).toBeInTheDocument();
  });

  it('a relaunch past the engine goes back to it when it’s signed out since', async () => {
    saveProgress('phonePair');
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready' }));
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    expect(await heading('Which AI should your agents run on?')).toBeInTheDocument();
  });

  it('the independence choice is saved, and a failure says so with Skip still there', async () => {
    saveProgress('independence');
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready', claude_auth: 'ready' }));
    setIndependence.mockRejectedValueOnce({ type: 'Other', message: 'Disk full' });
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    await heading('How much should your agents do on their own?');
    const slider = screen.getByRole('slider', { name: 'How much it does on its own' });
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringMatching(/^Steady\./));
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringMatching(/^Bold\./));
    press('Continue');
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full');
    press('Continue');
    expect(await heading('Use your agents from your phone?')).toBeInTheDocument();
    expect(setIndependence).toHaveBeenLastCalledWith('go_hard');
  });

  it('a fresh machine picks an engine, then sees one screen for its first step', async () => {
    saveProgress('engine');
    getFullSetupStatus.mockResolvedValue(machine());
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    await heading('Which AI should your agents run on?');
    const claude = screen.getByText('Claude Code', { selector: '.agent-pick-card-name' });
    expect(screen.getByText('Codex', { selector: '.agent-pick-card-name' })).toBeInTheDocument();
    fireEvent.click(claude.closest('button') as HTMLElement);
    expect(await heading('Install Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Claude Code · 1 of 2')).toBeInTheDocument();
  });

  it('force mode shows the choice even with an engine ready; its card goes on', async () => {
    saveProgress('engine');
    getOnboardingTestMode.mockResolvedValue({ mock: false, forceOnboarding: true });
    getFullSetupStatus.mockResolvedValue(machine({ claude: 'ready', claude_auth: 'ready' }));
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    await heading('Which AI should your agents run on?');
    fireEvent.click(
      screen.getByText('Claude Code', { selector: '.agent-pick-card-name' }).closest('button')!
    );
    expect(await heading('How much should your agents do on their own?')).toBeInTheDocument();
    expect(setDefaultAgentId).toHaveBeenCalledWith('claude-code');
  });

  it('a failed status check offers a retry instead of guessing', async () => {
    getFullSetupStatus.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(machine());
    render(<AgentOnboardingScreen onComplete={vi.fn()} />);
    expect(await screen.findByText('Couldn’t check this Mac. Try again.')).toBeInTheDocument();
    press('Try again');
    await waitFor(() =>
      expect(screen.queryByText('Couldn’t check this Mac. Try again.')).not.toBeInTheDocument()
    );
  });
});
