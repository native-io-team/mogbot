import { act, fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAppMode } from './useAppMode';
import { getSnapshot } from '../commands/registry';
import type { AppView } from '../lib/types';

function setup(initial: AppView, projectPath: string | null = null) {
  const setView = vi.fn();
  const openProject = vi.fn();
  const cancelPendingOpen = vi.fn();
  const hook = renderHook(
    ({ view, path }: { view: AppView; path: string | null }) =>
      useAppMode({ view, setView, currentProjectPath: path, openProject, cancelPendingOpen }),
    { initialProps: { view: initial, path: projectPath } }
  );
  return { ...hook, setView, openProject, cancelPendingOpen };
}

const pressToggle = () =>
  fireEvent.keyDown(window, { key: 'A', code: 'KeyA', metaKey: true, shiftKey: true });

describe('useAppMode', () => {
  it('returns to the dashboard when that was the last Projects place', () => {
    const { result, rerender, setView } = setup('projects');
    rerender({ view: 'agents', path: null });
    act(() => result.current.onGoProjects());
    expect(setView).toHaveBeenLastCalledWith('projects');
  });

  it('shows the open project at once, and re-enters it the way a sidebar click does', () => {
    const { result, rerender, setView, openProject } = setup('workspace', '/p/acme');
    rerender({ view: 'agents', path: '/p/acme' });
    act(() => result.current.onGoProjects());
    // In the same tick: waiting on the re-entry's round-trips left the
    // switch looking dead, which is what invited the second click.
    expect(setView).toHaveBeenCalledWith('workspace');
    expect(openProject).toHaveBeenCalledWith('/p/acme');
  });

  it('only waits for the open when the project is no longer loaded here', () => {
    const { result, rerender, setView, openProject } = setup('workspace', '/p/acme');
    rerender({ view: 'agents', path: null });
    act(() => result.current.onGoProjects());
    expect(openProject).toHaveBeenCalledWith('/p/acme');
    expect(setView).not.toHaveBeenCalled();
  });

  it('tells an open still in flight to stand down when you go to Agents', () => {
    const { result, setView, cancelPendingOpen } = setup('workspace', '/p/acme');
    act(() => result.current.onGoAgents());
    expect(cancelPendingOpen).toHaveBeenCalledTimes(1);
    expect(setView).toHaveBeenLastCalledWith('agents');
  });

  it('stands an open down for every non-project screen, never for the workspace', () => {
    const { result, cancelPendingOpen } = setup('agents');
    act(() => result.current.navigate('inbox'));
    act(() => result.current.navigate('projects'));
    expect(cancelPendingOpen).toHaveBeenCalledTimes(2);
    act(() => result.current.navigate('workspace'));
    expect(cancelPendingOpen).toHaveBeenCalledTimes(2);
  });

  it('keeps its callbacks stable when the App re-renders with a new openProject', () => {
    const setView = vi.fn();
    const hook = renderHook(
      ({ open }: { open: (p: string) => void }) =>
        useAppMode({ view: 'agents', setView, currentProjectPath: null, openProject: open }),
      { initialProps: { open: vi.fn() } }
    );
    const first = hook.result.current;
    hook.rerender({ open: vi.fn() });
    expect(hook.result.current).toBe(first);
  });

  it('flips there and back on two presses inside one frame', () => {
    const { setView } = setup('projects');
    // No re-render between the presses: the second must still flip back.
    pressToggle();
    pressToggle();
    expect(setView.mock.calls.map(([v]) => v as AppView)).toEqual(['agents', 'projects']);
  });

  it('switches on every one of fifty presses as the view follows', () => {
    const { rerender, setView } = setup('agents');
    let view: AppView = 'agents';
    for (let i = 0; i < 50; i++) {
      pressToggle();
      const next = setView.mock.lastCall?.[0] as AppView;
      expect(next).toBe(view === 'agents' ? 'projects' : 'agents');
      view = next;
      rerender({ view, path: null });
    }
  });

  it('remembers Workflows and the Inbox too', () => {
    const { result, rerender, setView } = setup('inbox');
    rerender({ view: 'agents', path: null });
    act(() => result.current.onGoProjects());
    expect(setView).toHaveBeenLastCalledWith('inbox');
  });

  it('flips modes with ⌘⇧A', () => {
    const { rerender, setView } = setup('projects');
    pressToggle();
    expect(setView).toHaveBeenLastCalledWith('agents');
    rerender({ view: 'agents', path: null });
    pressToggle();
    expect(setView).toHaveBeenLastCalledWith('projects');
  });

  it('leaves ⌘⇧A alone outside the modes and under a dialog', () => {
    const { rerender, setView } = setup('onboarding');
    pressToggle();
    rerender({ view: 'projects', path: null });
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    pressToggle();
    dialog.remove();
    expect(setView).not.toHaveBeenCalled();
  });

  it('registers agents.toggleMode in the palette', () => {
    const { setView } = setup('projects');
    const command = getSnapshot().find((c) => c.id === 'agents.toggleMode');
    expect(command?.title).toBe('Switch to Agents');
    act(() => void command?.run());
    expect(setView).toHaveBeenCalledWith('agents');
  });

  it('the palette command follows the view both ways', () => {
    const { rerender, setView } = setup('agents');
    const run = () => getSnapshot().find((c) => c.id === 'agents.toggleMode');
    expect(run()?.title).toBe('Switch to Projects');
    act(() => void run()?.run());
    expect(setView).toHaveBeenLastCalledWith('projects');
    rerender({ view: 'projects', path: null });
    expect(run()?.title).toBe('Switch to Agents');
    act(() => void run()?.run());
    expect(setView).toHaveBeenLastCalledWith('agents');
  });
});
