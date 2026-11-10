/**
 * The engine's install and sign-in screens run like a native installer:
 * plain steps moved on only by what the real process prints, what it waits
 * on asked in plain words, the real output under "Show details", and a
 * failure said as its one cause with the one fix. The process is a stand-in
 * terminal here; nothing is installed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SetupItem } from '../../../lib/setup';

const checkClaudeAuthStatus = vi.hoisted(() => vi.fn());
const getFullSetupStatus = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/setup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/setup')>();
  return { ...actual, checkClaudeAuthStatus, getFullSetupStatus };
});
vi.mock('../../../lib/analytics', () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
  setActiveScreen: vi.fn(),
}));

interface TerminalProps {
  command: string;
  onOutput: (text: string) => void;
  onExit: (code: number | null, tail: string) => void;
  inputRef: { current: ((data: string) => void) | null };
}
const pty = vi.hoisted(() => ({
  props: null as TerminalProps | null,
  typed: [] as string[],
}));
vi.mock('../OnboardingTerminal', () => ({
  OnboardingTerminal: (props: TerminalProps) => {
    pty.props = props;
    props.inputRef.current = (data: string) => pty.typed.push(data);
    return <div data-testid="live-terminal" />;
  },
}));

import { EngineStep } from './EngineStep';

const item = (id: string, status: SetupItem['status']): SetupItem => ({
  id,
  friendlyName: id === 'claude' ? 'Claude Code' : id,
  status,
});

function renderStep(over: Record<string, SetupItem['status']> = {}) {
  let items = ['homebrew', 'node', 'claude', 'claude_auth', 'codex', 'codex_auth'].map((id) =>
    item(id, over[id] ?? 'not_installed')
  );
  const fetchStatus = vi.fn(() => Promise.resolve({ allReady: false, items } as never));
  const utils = render(<Harness />);
  function Harness() {
    return (
      <EngineStep
        items={items}
        fetchStatus={fetchStatus}
        updateItemStatus={(id, updates) => {
          items = items.map((i) => (i.id === id ? { ...i, ...updates } : i));
          utils?.rerender(<Harness />);
        }}
        mock={false}
        forcePick={false}
        onEngineReady={vi.fn()}
        onBack={vi.fn()}
      />
    );
  }
  return { ...utils, setItems: (next: typeof items) => (items = next) };
}

const pickCard = (name: string) =>
  fireEvent.click(
    screen.getByText(name, { selector: '.agent-pick-card-name' }).closest('button') as HTMLElement
  );
const output = (text: string) => act(() => pty.props!.onOutput(text));
const stepState = (label: RegExp) => screen.getByText(label).closest('li')?.dataset.state;

describe('EngineStep installs', () => {
  beforeEach(() => {
    pty.props = null;
    pty.typed = [];
    checkClaudeAuthStatus.mockReset().mockResolvedValue(false);
    getFullSetupStatus.mockReset().mockResolvedValue({ items: [] });
  });

  it('shows plain steps moved on by the real output, with the terminal folded away', async () => {
    renderStep();
    pickCard('Claude Code');
    await waitFor(() => expect(pty.props).not.toBeNull());
    expect(stepState(/^Downloading Claude Code/)).toBe('current');
    expect(stepState(/^Installing/)).toBe('todo');
    // Our own "Downloading the installer" echo is not the installer installing.
    output('Downloading the Claude Code installer…\r\n######## 100.0%\r\n');
    expect(stepState(/^Downloading Claude Code/)).toBe('current');
    output('Setting up Claude Code...\r\n');
    expect(stepState(/^Downloading Claude Code/)).toBe('done');
    expect(stepState(/^Installing/)).toBe('current');

    // The terminal is there, folded; Show details opens it.
    const toggle = screen.getByRole('button', { name: 'Show details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByTestId('live-terminal')).toBeInTheDocument();
  });

  it('a failure says its one cause and fix, with Try again and what it printed', async () => {
    renderStep();
    pickCard('Claude Code');
    await waitFor(() => expect(pty.props).not.toBeNull());
    const printed = 'error: write /Users/sam/.local/bin/claude: no space left on device\r\n';
    output(printed);
    act(() => pty.props!.onExit(1, printed));
    expect(await screen.findByText(/This Mac is out of disk space\./)).toBeInTheDocument();
    expect(screen.getByText(/Free up at least 1 GB/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText(/no space left on device/, { selector: 'pre' })).toBeInTheDocument();
  });

  it('asks for the Mac password in a field of its own and types it into the installer', async () => {
    // Codex on a bare Mac: Homebrew first, whose installer asks for the password.
    renderStep();
    pickCard('Codex');
    await waitFor(() => expect(pty.props?.command).toBe('/bin/bash'));
    output('==> Checking for `sudo` access (which may request your password)...\r\nPassword:');
    const field = await screen.findByLabelText(/needs your Mac password/);
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.change(field, { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(pty.typed).toEqual(['hunter2\r']);
    // Answered: the field goes once the installer prints past the prompt.
    output('\r\n==> This script will install:\r\n');
    expect(screen.queryByLabelText(/needs your Mac password/)).not.toBeInTheDocument();
    output('Press RETURN/ENTER to continue or any other key to abort:');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(pty.typed).toEqual(['hunter2\r', '\r']);
  });

  it('a sign-in offers its page again, and notices on its own when it is done', async () => {
    getFullSetupStatus.mockResolvedValue({ items: [item('claude_auth', 'not_installed')] });
    renderStep({ claude: 'ready' });
    pickCard('Claude Code');
    expect(await screen.findByRole('heading', { name: 'Sign in to Claude Code' })).toBeVisible();
    await waitFor(() => expect(pty.props).not.toBeNull());
    output('If the browser didn’t open, visit: https://claude.ai/oauth/authorize?code=true\r\n');
    expect(stepState(/^Waiting for you to sign in/)).toBe('current');
    expect(screen.getByRole('button', { name: /Open the sign-in page again/ })).toBeInTheDocument();
    // The app's own check says signed in: the run ends without the command exiting.
    getFullSetupStatus.mockResolvedValue({ items: [item('claude_auth', 'ready')] });
    await waitFor(() => expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument(), {
      timeout: 6000,
    });
  }, 10_000);

  it('Cancel stops it and the screen says it was closed', async () => {
    renderStep();
    pickCard('Claude Code');
    await waitFor(() => expect(pty.props).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
    expect(
      await screen.findByText(/The install was closed before it finished\./)
    ).toBeInTheDocument();
  });
});
