/**
 * Where launch lands. Agents (the Chief of Staff) for anyone set up on an
 * engine Agents runs on; their projects for someone set up on another agent
 * CLI; a project window's workspace by way of 'projects'. And the background
 * check after a fast launch only logs: it never sends anyone back to
 * onboarding.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { hasAgentsEngine, postSetupViewFor, useAppSetup } from './useAppSetup';
import type { AppView } from '../lib/types';

describe('postSetupViewFor', () => {
  it('lands on Agents once setup is done', () => {
    expect(postSetupViewFor()).toBe('agents');
    expect(postSetupViewFor(null, true)).toBe('agents');
  });

  it('sends a project window through projects, where auto-open picks it up', () => {
    expect(postSetupViewFor('/p', true)).toBe('projects');
    expect(postSetupViewFor('/p', false)).toBe('projects');
  });

  it('lands someone without an Agents engine on their projects', () => {
    expect(postSetupViewFor(null, false)).toBe('projects');
  });

  it('opens onboarding again while it was left unfinished, but never a project window', () => {
    expect(postSetupViewFor(null, true, true)).toBe('onboarding');
    expect(postSetupViewFor('/p', true, true)).toBe('projects');
  });
});

describe('hasAgentsEngine', () => {
  it('counts only the engines Agents runs on', () => {
    expect(hasAgentsEngine(['claude-code'])).toBe(true);
    expect(hasAgentsEngine(['opencode', 'codex'])).toBe(true);
    expect(hasAgentsEngine(['opencode', 'cursor'])).toBe(false);
    expect(hasAgentsEngine([])).toBe(false);
  });
});

function makeParams() {
  let view: AppView = 'loading';
  const setView = vi.fn((next: AppView | ((prev: AppView) => AppView)) => {
    view = typeof next === 'function' ? next(view) : next;
  });
  return {
    params: {
      view: 'loading' as AppView,
      setView,
      setCurrentProject: vi.fn(),
      setDevServerPort: vi.fn(),
      setWorkspaceTab: vi.fn(),
      setIsPreviewHidden: vi.fn(),
      handleSelectProject: vi.fn().mockResolvedValue(undefined),
      refreshAllCliStatuses: vi.fn().mockResolvedValue(undefined),
      setProjectGitHubStatus: vi.fn(),
      fetchBranchInfo: vi.fn().mockResolvedValue(undefined),
      openHelpModal: vi.fn(),
    },
    currentView: () => view,
  };
}

function arm(quick: Record<string, unknown>, fullReady: boolean, fullCalls: { n: number }) {
  mockWindows('main');
  mockIPC((cmd) => {
    switch (cmd) {
      case 'quick_setup_check':
        return quick;
      case 'get_full_setup_status':
        fullCalls.n += 1;
        return { allReady: fullReady, allPresent: fullReady, items: [], detectedAgents: [] };
      case 'get_default_agent':
        return 'claude-code';
      default:
        return undefined;
    }
  });
}

describe('useAppSetup landing', () => {
  beforeEach(() => sessionStorage.clear());

  it('a returning user lands on Agents', async () => {
    const calls = { n: 0 };
    arm({ setupCompleteCached: true, allPresent: true, agentsEngine: true }, true, calls);
    const { params, currentView } = makeParams();
    renderHook(() => useAppSetup(params));
    await waitFor(() => expect(currentView()).toBe('agents'));
  });

  it('someone set up on another agent CLI lands on their projects', async () => {
    const calls = { n: 0 };
    arm({ setupCompleteCached: true, allPresent: true, agentsEngine: false }, true, calls);
    const { params, currentView } = makeParams();
    renderHook(() => useAppSetup(params));
    await waitFor(() => expect(currentView()).toBe('projects'));
  });

  it('a failing background check never bounces the user to onboarding', async () => {
    const calls = { n: 0 };
    arm({ setupCompleteCached: true, allPresent: true, agentsEngine: true }, false, calls);
    const { params, currentView } = makeParams();
    renderHook(() => useAppSetup(params));
    await waitFor(() => expect(calls.n).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(currentView()).toBe('agents');
    expect(params.setView).not.toHaveBeenCalledWith('onboarding');
  });

  it('a first launch with no engine ready goes to onboarding', async () => {
    const calls = { n: 0 };
    arm({ setupCompleteCached: false, allPresent: false, agentsEngine: false }, false, calls);
    const { params, currentView } = makeParams();
    renderHook(() => useAppSetup(params));
    await waitFor(() => expect(currentView()).toBe('onboarding'));
  });
});
