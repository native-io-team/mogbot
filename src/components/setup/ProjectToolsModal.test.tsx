/**
 * "Set up project tools": lists only what's required (Node, Git), offers
 * GitHub as optional with a way past it, carries on with the project start
 * that opened it, and drops that start on Cancel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SetupItem } from '../../lib/setup';

const getFullSetupStatus = vi.hoisted(() => vi.fn());
vi.mock('../../lib/setup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/setup')>();
  return { ...actual, getFullSetupStatus };
});
vi.mock('../../lib/agentOnboarding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/agentOnboarding')>();
  return {
    ...actual,
    getOnboardingTestMode: vi.fn().mockResolvedValue({ mock: false, forceOnboarding: false }),
  };
});
vi.mock('./agent-led/GuidedSetupPhase', () => ({
  GuidedSetupPhase: ({ toolIds }: { toolIds: string[] }) => (
    <div data-testid="guided">{toolIds.join(',')}</div>
  ),
}));

import { ProjectToolsModal } from './ProjectToolsModal';
import {
  resetProjectToolsForTests,
  takePendingProjectAction,
  useProjectToolsGate,
} from '../../lib/projectTools';

const openModal = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/ModalContext', () => ({ useOpenModal: () => openModal }));

const item = (id: string, status: SetupItem['status']): SetupItem => ({
  id,
  friendlyName: id,
  status,
});
const status = (over: Record<string, SetupItem['status']> = {}, claude = true) => ({
  allReady: true,
  items: [
    ...['homebrew', 'node', 'git', 'gh', 'gh_auth'].map((id) => item(id, over[id] ?? 'ready')),
    item('claude', claude ? 'ready' : 'not_installed'),
    item('claude_auth', claude ? 'ready' : 'not_installed'),
  ],
});

/** Park a project start behind the dialog, as a click on "New project" would. */
async function parkAction(action: () => void) {
  const gate = renderHook(() => useProjectToolsGate()).result.current;
  gate(action);
  await waitFor(() => expect(openModal).toHaveBeenCalled());
}

describe('ProjectToolsModal', () => {
  beforeEach(() => {
    resetProjectToolsForTests();
    localStorage.clear();
    openModal.mockReset();
    getFullSetupStatus.mockReset();
  });

  it('lists only the required tools, with GitHub as an option', async () => {
    getFullSetupStatus.mockResolvedValue(
      status({ node: 'not_installed', gh: 'not_installed', gh_auth: 'not_installed' })
    );
    render(<ProjectToolsModal isOpen onClose={vi.fn()} />);
    expect(await screen.findByText(/Node.js, which most sites/)).toBeInTheDocument();
    expect(screen.queryByText(/Git, which keeps/)).not.toBeInTheDocument();
    expect(screen.getByText('Optional')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set them up' }));
    expect(screen.getByTestId('guided').textContent).toContain('gh_auth');
  });

  it('Cancel drops the project start that opened it', async () => {
    getFullSetupStatus.mockResolvedValue(status({ git: 'not_installed' }));
    const action = vi.fn();
    await parkAction(action);
    const onClose = vi.fn();
    render(<ProjectToolsModal isOpen onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(takePendingProjectAction()).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it('with only GitHub missing, “Continue without” carries on and is remembered', async () => {
    getFullSetupStatus.mockResolvedValue(status({ gh_auth: 'not_installed' }));
    const action = vi.fn();
    await parkAction(action);
    render(<ProjectToolsModal isOpen onClose={vi.fn()} />);
    expect(await screen.findByText('Connect GitHub?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue without' }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('dashbot.projectTools.withoutGitHub')).toBe('1');
  });

  it('with nothing missing, Continue carries on', async () => {
    getFullSetupStatus.mockResolvedValue(status());
    const action = vi.fn();
    // The gate would have run it; park it directly as a dialog opened late would.
    getFullSetupStatus.mockResolvedValueOnce(status({ node: 'not_installed' }));
    await parkAction(action);
    render(<ProjectToolsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('without an engine to do the installing, says so and can’t start', async () => {
    getFullSetupStatus.mockResolvedValue(status({ node: 'not_installed' }, false));
    render(<ProjectToolsModal isOpen onClose={vi.fn()} />);
    expect(
      await screen.findByText(/Set up Claude Code or Codex in Agents first/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set them up' })).toBeDisabled();
  });
});
