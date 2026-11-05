/**
 * The project-tools gate: a project start runs straight away when Node and
 * Git are here, opens "Set up project tools" (keeping the action) when they
 * aren't, offers GitHub once, remembers a passing check for the session, and
 * never blocks on a check it couldn't make.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { SetupItem } from './setup';

const getFullSetupStatus = vi.hoisted(() => vi.fn());
vi.mock('./setup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./setup')>();
  return { ...actual, getFullSetupStatus };
});
const openModal = vi.hoisted(() => vi.fn());
vi.mock('../contexts/ModalContext', () => ({ useOpenModal: () => openModal }));

import {
  canStartProject,
  clearPendingProjectAction,
  declineGitHub,
  forgetProjectToolsCheck,
  resetProjectToolsForTests,
  takePendingProjectAction,
  useProjectToolsGate,
} from './projectTools';

const item = (id: string, status: SetupItem['status']): SetupItem => ({
  id,
  friendlyName: id,
  status,
});
const items = (over: Record<string, SetupItem['status']> = {}) =>
  ['homebrew', 'node', 'git', 'gh', 'gh_auth'].map((id) => item(id, over[id] ?? 'ready'));

function gate() {
  return renderHook(() => useProjectToolsGate()).result.current;
}

describe('project tools gate', () => {
  beforeEach(() => {
    resetProjectToolsForTests();
    localStorage.clear();
    getFullSetupStatus.mockReset();
    openModal.mockReset();
  });

  it('runs the action straight away when everything is here', async () => {
    getFullSetupStatus.mockResolvedValue({ items: items() });
    const action = vi.fn();
    gate()(action);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(openModal).not.toHaveBeenCalled();
  });

  it('remembers a passing check for the session, until told to forget it', async () => {
    getFullSetupStatus.mockResolvedValue({ items: items() });
    const run = gate();
    const first = vi.fn();
    run(first);
    await waitFor(() => expect(first).toHaveBeenCalled());
    const second = vi.fn();
    run(second);
    expect(second).toHaveBeenCalledTimes(1); // synchronously: no check
    expect(getFullSetupStatus).toHaveBeenCalledTimes(1);

    forgetProjectToolsCheck();
    run(vi.fn());
    await waitFor(() => expect(getFullSetupStatus).toHaveBeenCalledTimes(2));
  });

  it('opens the dialog when Node or Git is missing, and keeps the action for after', async () => {
    getFullSetupStatus.mockResolvedValue({ items: items({ node: 'not_installed' }) });
    const action = vi.fn();
    gate()(action);
    await waitFor(() => expect(openModal).toHaveBeenCalledWith('projectTools'));
    expect(action).not.toHaveBeenCalled();
    takePendingProjectAction()?.();
    expect(action).toHaveBeenCalledTimes(1);
    expect(takePendingProjectAction()).toBeNull(); // taken once
  });

  it('“Not now” drops the waiting action', async () => {
    getFullSetupStatus.mockResolvedValue({ items: items({ git: 'not_installed' }) });
    gate()(vi.fn());
    await waitFor(() => expect(openModal).toHaveBeenCalled());
    clearPendingProjectAction();
    expect(takePendingProjectAction()).toBeNull();
  });

  it('offers GitHub once; after “Continue without” it doesn’t ask again', async () => {
    getFullSetupStatus.mockResolvedValue({ items: items({ gh_auth: 'not_installed' }) });
    gate()(vi.fn());
    await waitFor(() => expect(openModal).toHaveBeenCalledTimes(1));

    resetProjectToolsForTests();
    declineGitHub();
    const action = vi.fn();
    gate()(action);
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(openModal).toHaveBeenCalledTimes(1);
  });

  it('carries on when the check itself fails', async () => {
    getFullSetupStatus.mockRejectedValue(new Error('timeout'));
    const action = vi.fn();
    gate()(action);
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(openModal).not.toHaveBeenCalled();
  });

  it('ignores a second click while the first is still checking', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    getFullSetupStatus.mockReturnValue(new Promise((r) => (resolve = r)));
    const run = gate();
    const first = vi.fn();
    const second = vi.fn();
    run(first);
    run(second);
    resolve({ items: items() });
    await waitFor(() => expect(first).toHaveBeenCalled());
    expect(second).not.toHaveBeenCalled();
    expect(getFullSetupStatus).toHaveBeenCalledTimes(1);
  });
});

describe('canStartProject', () => {
  it('needs only Node and Git; GitHub is optional once declined', () => {
    expect(canStartProject(items())).toBe(true);
    expect(canStartProject(items({ gh: 'not_installed', gh_auth: 'not_installed' }), true)).toBe(
      true
    );
    expect(canStartProject(items({ gh_auth: 'not_installed' }), false)).toBe(false);
    expect(canStartProject(items({ git: 'not_installed' }), true)).toBe(false);
  });
});
