/**
 * Tests for usePlugins' missing-bundle self-heal (issue #624).
 *
 * Plugins registered before the install-time bundle check (issue #381)
 * can have a valid manifest but no dist/index.js. The hook must repair
 * those by re-installing from source once, and — when repair isn't
 * possible — surface an actionable failure instead of the raw path error
 * (and without re-attempting the heal on every reload).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePlugins } from './usePlugins';
import type { PluginInfo } from '../lib/plugins';
import type { PluginModule } from '../lib/plugin-loader';

vi.mock('../lib/plugins', () => ({
  listPlugins: vi.fn(),
  updatePlugin: vi.fn(),
  // The hook asks this whether a plugin has been replaced by a native feature
  // or a skill. Defaults to "nothing is superseded"; individual tests below
  // override this to verify the filtering itself (issues #386/#804).
  supersededReason: vi.fn(() => null),
  isExpectedPluginFailure: () => false,
  approvePlugin: vi.fn(),
  needsApproval: (p: PluginInfo) =>
    (p.trust === 'unknown' || p.trust === 'changed') && p.sha256 !== null,
}));

vi.mock('../lib/plugin-loader', () => ({
  loadPluginModule: vi.fn(),
  unloadPluginModule: vi.fn(),
}));

import { listPlugins, updatePlugin, supersededReason, approvePlugin } from '../lib/plugins';
import { loadPluginModule } from '../lib/plugin-loader';

const mockListPlugins = vi.mocked(listPlugins);
const mockUpdatePlugin = vi.mocked(updatePlugin);
const mockLoadPluginModule = vi.mocked(loadPluginModule);
const mockSupersededReason = vi.mocked(supersededReason);

function makeInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    manifest: {
      id: 'dependency-checker',
      name: 'Dependency Checker',
      version: '1.0.0',
      description: '',
      slots: ['toolbar'],
      author: '',
      repository: '',
      setup: [],
      min_app_version: '',
      icon: '',
      required_commands: [],
      api_version: 1,
    },
    enabled: true,
    installed_at: 0,
    source_url: 'https://github.com/ship-studio/plugin-dependency-checker',
    is_dev: false,
    local_path: '',
    trust: 'trusted',
    sha256: 'abc123',
    source_path: '/p/.shipstudio/plugins/x',
    ...overrides,
  };
}

const workingModule: PluginModule = { name: 'Dependency Checker', slots: {} };

const missingBundleError = new Error(
  'Plugin bundle not found: /p/.shipstudio/plugins/dependency-checker/dist/index.js'
);

beforeEach(() => {
  vi.clearAllMocks();
  mockSupersededReason.mockImplementation(() => null);
});

describe('usePlugins missing-bundle self-heal', () => {
  it('re-installs from source and loads the plugin when the bundle is missing', async () => {
    mockListPlugins.mockResolvedValue([makeInfo()]);
    mockLoadPluginModule
      .mockRejectedValueOnce(missingBundleError)
      .mockResolvedValueOnce(workingModule);
    mockUpdatePlugin.mockResolvedValue(makeInfo());

    const { result } = renderHook(() => usePlugins('/projects/heal-success'));

    await waitFor(() => expect(result.current.plugins).toHaveLength(1));
    expect(mockUpdatePlugin).toHaveBeenCalledWith('/projects/heal-success', 'dependency-checker');
    expect(result.current.failures).toHaveLength(0);
  });

  it('surfaces an actionable failure when the re-install also fails', async () => {
    mockListPlugins.mockResolvedValue([makeInfo()]);
    mockLoadPluginModule.mockRejectedValue(missingBundleError);
    mockUpdatePlugin.mockRejectedValue(new Error('Git clone failed: no network'));

    const { result } = renderHook(() => usePlugins('/projects/heal-failure'));

    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    expect(result.current.plugins).toHaveLength(0);
    expect(result.current.failures[0].reason).toContain('Uninstall and reinstall');
    // The raw bundle path must not leak into the user-facing reason.
    expect(result.current.failures[0].reason).not.toContain('dist/index.js');
  });

  it('does not retry the heal for the same plugin within a session', async () => {
    mockListPlugins.mockResolvedValue([makeInfo()]);
    mockLoadPluginModule.mockRejectedValue(missingBundleError);
    mockUpdatePlugin.mockRejectedValue(new Error('Git clone failed'));

    const { result } = renderHook(() => usePlugins('/projects/heal-once'));
    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    expect(mockUpdatePlugin).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.reloadPlugins();
    });
    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    // Reload re-fails, but no second network re-install is attempted.
    expect(mockUpdatePlugin).toHaveBeenCalledTimes(1);
  });

  it('never self-heals dev plugins', async () => {
    mockListPlugins.mockResolvedValue([
      makeInfo({ is_dev: true, local_path: '/dev/plugin', source_url: '' }),
    ]);
    mockLoadPluginModule.mockRejectedValue(missingBundleError);

    const { result } = renderHook(() => usePlugins('/projects/dev-plugin'));

    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    expect(mockUpdatePlugin).not.toHaveBeenCalled();
  });

  it('does not heal unrelated load failures', async () => {
    mockListPlugins.mockResolvedValue([makeInfo()]);
    mockLoadPluginModule.mockRejectedValue(new Error('Plugin must export a name'));

    const { result } = renderHook(() => usePlugins('/projects/other-error'));

    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    expect(mockUpdatePlugin).not.toHaveBeenCalled();
    expect(result.current.failures[0].reason).toContain('Plugin must export a name');
  });
});

describe('usePlugins skips superseded plugins entirely (issues #386, #804)', () => {
  // A superseded plugin (native hosting replaced vercel/cloudflare/netlify)
  // must be filtered out before loadPluginModule ever runs — not merely
  // hidden from render — so its onActivate hook and background timers never
  // start. That's what keeps a bundled hosting plugin's stale/missing files
  // from ever reaching the "deactivated" toast (#386), and what keeps its
  // old required_commands calls (e.g. a removed DNS-credential lookup, #804)
  // from ever firing again.
  it('never calls loadPluginModule for a plugin with a supersededReason', async () => {
    mockListPlugins.mockResolvedValue([
      makeInfo({
        manifest: {
          id: 'cloudflare',
          name: 'Cloudflare Pages',
          version: '1.0.0',
          description: '',
          slots: ['toolbar'],
          author: '',
          repository: '',
          setup: [],
          min_app_version: '',
          icon: '',
          required_commands: [],
          api_version: 1,
        },
      }),
    ]);
    mockSupersededReason.mockImplementation((id: string) =>
      id === 'cloudflare' ? 'Hosting is built in now.' : null
    );

    const { result } = renderHook(() => usePlugins('/projects/superseded'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.plugins).toHaveLength(0);
    expect(result.current.failures).toHaveLength(0);
    expect(mockLoadPluginModule).not.toHaveBeenCalled();
  });
});

describe('usePlugins plugin approvals', () => {
  it('never loads a plugin the user has not allowed, and asks about it instead', async () => {
    const unknown = makeInfo({ trust: 'unknown', sha256: 'feed' });
    mockListPlugins.mockResolvedValue([unknown]);
    const { result } = renderHook(() => usePlugins('/p/a'));
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(mockLoadPluginModule).not.toHaveBeenCalled();
    expect(result.current.plugins).toEqual([]);
    expect(result.current.failures).toEqual([]);
  });

  it('asks again about a plugin whose files changed since it was allowed', async () => {
    mockListPlugins.mockResolvedValue([makeInfo({ trust: 'changed', sha256: 'new' })]);
    const { result } = renderHook(() => usePlugins('/p/b'));
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(mockLoadPluginModule).not.toHaveBeenCalled();
  });

  it('allowing records exactly the digest shown, then loads the plugin', async () => {
    const unknown = makeInfo({ trust: 'unknown', sha256: 'feed' });
    mockListPlugins.mockResolvedValueOnce([unknown]);
    const { result } = renderHook(() => usePlugins('/p/c'));
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));

    mockListPlugins.mockResolvedValue([{ ...unknown, trust: 'trusted' }]);
    mockLoadPluginModule.mockResolvedValue(workingModule);
    await act(async () => {
      await result.current.approvePending(unknown);
    });
    expect(vi.mocked(approvePlugin)).toHaveBeenCalledWith('/p/c', 'dependency-checker', 'feed');
    await waitFor(() => expect(result.current.plugins).toHaveLength(1));
    expect(result.current.pendingApprovals).toEqual([]);
  });

  it('"Don\'t load" stops asking for the rest of the session', async () => {
    const unknown = makeInfo({ trust: 'unknown', sha256: 'cafe' });
    mockListPlugins.mockResolvedValue([unknown]);
    const { result } = renderHook(() => usePlugins('/p/d'));
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    act(() => result.current.declinePending(unknown));
    expect(result.current.pendingApprovals).toEqual([]);
    await act(async () => {
      await result.current.reloadPlugins();
    });
    expect(result.current.pendingApprovals).toEqual([]);
    expect(mockLoadPluginModule).not.toHaveBeenCalled();
  });

  it('a dev plugin with developer mode off is explained, not loaded or asked about', async () => {
    mockListPlugins.mockResolvedValue([
      makeInfo({ is_dev: true, local_path: '/dev/x', trust: 'dev_mode_off' }),
    ]);
    const { result } = renderHook(() => usePlugins('/p/e'));
    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    expect(result.current.failures[0].reason).toMatch(/plugin developer mode/);
    expect(result.current.pendingApprovals).toEqual([]);
    expect(mockLoadPluginModule).not.toHaveBeenCalled();
  });
});
