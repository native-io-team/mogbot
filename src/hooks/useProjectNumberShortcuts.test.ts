import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventCallback } from '@tauri-apps/api/event';
import { ModalProvider } from '../contexts/ModalContext';
import { sessionRegistry } from '../lib/sessionRegistry';
import { mockInvokeResponse } from '../test/setup';
import { listen } from '@tauri-apps/api/event';
import { usePinnedProjects } from './usePinnedProjects';
import { useProjectNumberShortcuts } from './useProjectNumberShortcuts';
import { setActiveProjectOrder } from '../lib/activeProjectOrder';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useProjectNumberShortcuts', () => {
  afterEach(() => {
    sessionRegistry._resetForTests();
    vi.clearAllMocks();
  });

  it('uses the latest pinned order when Cmd+number selects a project', async () => {
    let switchProject!: EventCallback<string>;
    vi.mocked(listen).mockImplementation((_event, callback) => {
      switchProject = callback;
      return Promise.resolve(vi.fn());
    });
    const handleSelectProject = vi.fn();
    const { rerender } = renderHook(
      ({ pinnedPaths }: { pinnedPaths: string[] }) =>
        useProjectNumberShortcuts({ pinnedPaths, handleSelectProject }),
      {
        initialProps: { pinnedPaths: ['/projects/alpha', '/projects/beta'] },
        wrapper: ModalProvider,
      }
    );

    await waitFor(() => expect(switchProject).toBeTypeOf('function'));
    act(() => switchProject({ event: 'menu://action', id: 1, payload: 'go_to_1' }));
    expect(handleSelectProject).toHaveBeenLastCalledWith({
      name: 'alpha',
      path: '/projects/alpha',
      thumbnail: null,
    });

    rerender({ pinnedPaths: ['/projects/beta', '/projects/alpha'] });
    act(() => switchProject({ event: 'menu://action', id: 2, payload: 'go_to_1' }));
    expect(handleSelectProject).toHaveBeenLastCalledWith({
      name: 'beta',
      path: '/projects/beta',
      thumbnail: null,
    });
  });

  it('keeps number shortcuts on confirmed order during a pending reorder', async () => {
    mockInvokeResponse('list_pinned_projects', ['/projects/alpha', '/projects/beta']);
    const commitResponse = deferred<string[]>();
    mockInvokeResponse('reorder_pins', () => commitResponse.promise);

    let switchProject!: EventCallback<string>;
    vi.mocked(listen).mockImplementation((_event, callback) => {
      switchProject = callback;
      return Promise.resolve(vi.fn());
    });
    const handleSelectProject = vi.fn();
    const { result } = renderHook(
      () => {
        const pins = usePinnedProjects(null);
        useProjectNumberShortcuts({
          pinnedPaths: [...pins.confirmedPaths],
          handleSelectProject,
        });
        return pins;
      },
      { wrapper: ModalProvider }
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(switchProject).toBeTypeOf('function');
    });

    let commit!: Promise<void>;
    act(() => {
      commit = result.current.reorder(['/projects/beta', '/projects/alpha']);
    });
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.projectPath)).toEqual([
        '/projects/beta',
        '/projects/alpha',
      ])
    );
    expect(result.current.confirmedPaths).toEqual(['/projects/alpha', '/projects/beta']);

    act(() => switchProject({ event: 'menu://action', id: 1, payload: 'go_to_1' }));
    expect(handleSelectProject).toHaveBeenLastCalledWith({
      name: 'alpha',
      path: '/projects/alpha',
      thumbnail: null,
    });

    await act(async () => {
      commitResponse.resolve(['/projects/beta', '/projects/alpha']);
      await commit;
    });
    act(() => switchProject({ event: 'menu://action', id: 1, payload: 'go_to_1' }));
    expect(handleSelectProject).toHaveBeenLastCalledWith({
      name: 'beta',
      path: '/projects/beta',
      thumbnail: null,
    });
  });

  it('uses the persisted Active order before the alphabetical fallback', async () => {
    sessionRegistry.getOrCreate('/projects/alpha-active');
    sessionRegistry.getOrCreate('/projects/beta-active');
    setActiveProjectOrder(['/projects/beta-active', '/projects/alpha-active']);

    let switchProject!: EventCallback<string>;
    vi.mocked(listen).mockImplementation((_event, callback) => {
      switchProject = callback;
      return Promise.resolve(vi.fn());
    });
    const handleSelectProject = vi.fn();
    renderHook(() => useProjectNumberShortcuts({ pinnedPaths: [], handleSelectProject }), {
      wrapper: ModalProvider,
    });

    await waitFor(() => expect(switchProject).toBeTypeOf('function'));
    act(() => switchProject({ event: 'menu://action', id: 1, payload: 'go_to_1' }));
    expect(handleSelectProject).toHaveBeenLastCalledWith({
      name: 'beta-active',
      path: '/projects/beta-active',
      thumbnail: null,
    });
  });
});
