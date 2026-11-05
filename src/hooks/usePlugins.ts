/**
 * Hook for managing plugin lifecycle.
 *
 * Loads enabled plugins for the current project, tracks loaded modules,
 * and provides helpers for querying which plugins register for specific UI slots.
 *
 * Failures (unsupported API version, bundle load errors, registry list errors)
 * are exposed via `failures` so the UI can show them instead of silently
 * shrinking the plugin list; lifecycle-hook errors are reported through the
 * optional `onError` callback.
 *
 * @module hooks/usePlugins
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  listPlugins,
  updatePlugin,
  approvePlugin,
  needsApproval,
  isExpectedPluginFailure,
  supersededReason,
  PluginInfo,
} from '../lib/plugins';
import { PLUGIN_DEV_MODE_CHANGED_EVENT } from '../lib/settings';
import { loadPluginModule, unloadPluginModule, PluginModule } from '../lib/plugin-loader';
import { asCommandError, formatCommandError } from '../lib/errors';
import { logger } from '../lib/logger';

/** API versions the host supports. Plugins with unsupported versions are skipped. */
const SUPPORTED_API_VERSIONS = [0, 1];

/**
 * Plugins we already tried to self-heal this app session, keyed
 * `projectPath:pluginId` — a failed heal must not retry (and re-clone) on
 * every reload.
 */
const attemptedSelfHeals = new Set<string>();

/**
 * Plugins the user chose "Don't load" for this app session, keyed
 * `projectPath:pluginId:sha256` — asked again next launch, or as soon as the
 * files change, never again before.
 */
const declinedThisSession = new Set<string>();

function declineKey(path: string, info: PluginInfo): string {
  return `${path}:${info.manifest.id}:${info.sha256 ?? ''}`;
}

/** The backend refused a bundle the user hasn't allowed (`plugin_trust.rs`). */
function isNotAllowedError(message: string): boolean {
  return message.includes('Plugin not allowed');
}

/** The load failure produced by a registry entry whose built bundle is gone. */
function isMissingBundleError(message: string): boolean {
  return message.includes('Plugin bundle not found');
}

/**
 * Load a plugin's module, self-healing a missing bundle by re-installing from
 * the plugin's source repository (issue #624).
 *
 * Installs made before the install-time bundle check existed (issue #381)
 * could register a plugin with a valid manifest but no dist/index.js; nothing
 * ever repaired those entries, so they failed identically on every session
 * forever. One re-install from source (which now validates the bundle) fixes
 * them for good. Tried at most once per plugin per session.
 */
async function loadModuleWithSelfHeal(
  path: string,
  info: PluginInfo,
  onLifecycleError: (pluginName: string, error: unknown) => void
): Promise<PluginModule> {
  try {
    return await loadPluginModule(path, info.manifest.id, onLifecycleError);
  } catch (e) {
    const message = formatCommandError(asCommandError(e));
    const healKey = `${path}:${info.manifest.id}`;
    const canHeal =
      !info.is_dev &&
      info.source_url &&
      isMissingBundleError(message) &&
      !attemptedSelfHeals.has(healKey);
    if (!canHeal) {
      throw e;
    }
    attemptedSelfHeals.add(healKey);
    logger.warn('Plugin bundle missing; re-installing from source to self-heal', {
      plugin: info.manifest.id,
    });
    try {
      await updatePlugin(path, info.manifest.id);
    } catch (healError) {
      logger.warn('Plugin self-heal re-install failed', {
        plugin: info.manifest.id,
        error: formatCommandError(asCommandError(healError)),
      });
      // Surface the original missing-bundle state, not the update error.
      throw e;
    }
    return await loadPluginModule(path, info.manifest.id, onLifecycleError);
  }
}

/** A fully loaded plugin: manifest + JS module */
export interface LoadedPlugin {
  info: PluginInfo;
  module: PluginModule;
}

/** A plugin that could not be loaded, with a user-facing reason */
export interface PluginFailure {
  /** Manifest id, or null when the failure isn't tied to one plugin (list error) */
  id: string | null;
  name: string;
  reason: string;
}

/** Options for usePlugins */
export interface UsePluginsOptions {
  /** Called when a plugin's onActivate/onDeactivate lifecycle hook throws. */
  onError?: (pluginName: string, message: string) => void;
}

/** The approval side of plugins, as one object for prop groups. */
export interface PluginTrustApi {
  pending: PluginInfo[];
  approve: (info: PluginInfo) => Promise<void>;
  decline: (info: PluginInfo) => void;
}

/** Return type for usePlugins hook */
export interface UsePluginsReturn {
  /** `pendingApprovals` / `approvePending` / `declinePending`, grouped. */
  trust: PluginTrustApi;
  /**
   * Plugins this project lists that the user hasn't allowed (or whose files
   * changed since). They are not loaded; the UI asks, quietly.
   */
  pendingApprovals: PluginInfo[];
  /** Allow a pending plugin's files as shown, then load it. */
  approvePending: (info: PluginInfo) => Promise<void>;
  /** "Don't load": not asked again this session unless its files change. */
  declinePending: (info: PluginInfo) => void;
  /** All loaded plugins */
  plugins: LoadedPlugin[];
  /** Plugins that failed to load (unsupported API version, bad bundle, list error) */
  failures: PluginFailure[];
  /** Get plugins registered for a specific UI slot */
  getSlotPlugins: (slotName: string) => LoadedPlugin[];
  /** Reload all plugins (call after install/uninstall) */
  reloadPlugins: () => Promise<void>;
  /** Whether plugins are currently loading */
  isLoading: boolean;
}

export function usePlugins(
  projectPath: string | null,
  options?: UsePluginsOptions
): UsePluginsReturn {
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
  const [failures, setFailures] = useState<PluginFailure[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PluginInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);
  const currentPathRef = useRef(projectPath);

  // Keep the latest onError without re-triggering plugin loads
  const onErrorRef = useRef(options?.onError);
  useEffect(() => {
    onErrorRef.current = options?.onError;
  });

  /** Stable lifecycle-error handler passed to the module loader. */
  const handleLifecycleError = useCallback((pluginName: string, error: unknown) => {
    onErrorRef.current?.(pluginName, formatCommandError(asCommandError(error)));
  }, []);

  const loadAllPlugins = useCallback(
    async (path: string | null) => {
      if (!path) {
        setPlugins([]);
        setFailures([]);
        setPendingApprovals([]);
        return;
      }

      setIsLoading(true);
      try {
        const installed = await listPlugins(path);
        // A plugin the app now does itself is skipped at load, not at render:
        // merely not rendering one still runs its activation hook and its
        // background timers, which was most of what made the old hosting
        // integration expensive. The Plugin Manager explains the skip.
        const wanted = installed.filter((p) => p.enabled && !supersededReason(p.manifest.id));
        const failed: PluginFailure[] = [];
        // A project's registry only says what it wants: nothing loads that
        // the user hasn't allowed in this app (the backend refuses the bundle
        // too). Missing files still go through, for the self-heal below.
        const pendingFrom = (list: PluginInfo[]) =>
          list.filter(
            (p) =>
              p.enabled &&
              !supersededReason(p.manifest.id) &&
              needsApproval(p) &&
              !declinedThisSession.has(declineKey(path, p))
          );
        let pending = pendingFrom(wanted);
        const enabled = wanted.filter((p) => {
          if (p.trust === 'dev_mode_off') {
            failed.push({
              id: p.manifest.id,
              name: p.manifest.name,
              reason:
                'A dev plugin. Turn on plugin developer mode in Settings → Experimental to load it.',
            });
            return false;
          }
          return p.trust === 'trusted' || p.trust === 'missing';
        });

        // Skip plugins with unsupported API versions
        const compatible = enabled.filter((info) => {
          const v = info.manifest.api_version ?? 0;
          if (!SUPPORTED_API_VERSIONS.includes(v)) {
            logger.warn(
              `Plugin "${info.manifest.id}" requires API v${v} which is not supported (supported: ${SUPPORTED_API_VERSIONS.join(', ')}). Skipping.`
            );
            failed.push({
              id: info.manifest.id,
              name: info.manifest.name,
              reason: `Requires plugin API v${v}; this app supports v${SUPPORTED_API_VERSIONS.join(', ')}. Update the app or the plugin.`,
            });
            return false;
          }
          return true;
        });

        const results = await Promise.allSettled(
          compatible.map((info) =>
            loadModuleWithSelfHeal(path, info, handleLifecycleError).then((module) => ({
              info,
              module,
            }))
          )
        );
        const loaded: LoadedPlugin[] = [];
        let refusedAfterRepair = false;
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            loaded.push(result.value);
          } else {
            const info = compatible[i];
            const message = formatCommandError(asCommandError(result.reason));
            if (isNotAllowedError(message)) {
              // Re-fetched by the self-heal: new files, so they're asked
              // about like any other (picked up from the re-list below).
              refusedAfterRepair = true;
              return;
            }
            if (isMissingBundleError(message)) {
              // A missing bundle that survived the self-heal is a broken
              // install the user has to redo — an expected machine state,
              // not an app malfunction, so warn (no auto-filed report;
              // issue #624) and tell them what to do instead of showing
              // the raw path.
              logger.warn('Plugin bundle missing after self-heal attempt', {
                plugin: info.manifest.id,
                error: message,
              });
              failed.push({
                id: info.manifest.id,
                name: info.manifest.name,
                reason:
                  'This plugin is missing its built files and could not be repaired automatically. Uninstall and reinstall it from the Plugin Manager.',
              });
              return;
            }
            logger.error('Failed to load plugin', {
              plugin: info.manifest.id,
              // Mirror failed.push below — String() on a CommandError object
              // logs "[object Object]" (issue #408).
              error: message,
            });
            failed.push({
              id: info.manifest.id,
              name: info.manifest.name,
              reason: message,
            });
          }
        });

        if (refusedAfterRepair) {
          pending = pendingFrom(await listPlugins(path).catch(() => []));
        }

        if (mountedRef.current && currentPathRef.current === path) {
          setPlugins(loaded);
          setFailures(failed);
          setPendingApprovals(pending);
        }
      } catch (e) {
        // Full Disk Access / read-only volume / a project folder that's gone
        // are environment states the backend classifies Expected — the UI
        // already surfaces them in `failures`, so logger.error would file a
        // bug report for the app behaving correctly (issue #762).
        logger[isExpectedPluginFailure(e) ? 'warn' : 'error']('Failed to list plugins', {
          error: formatCommandError(asCommandError(e)),
        });
        if (mountedRef.current && currentPathRef.current === path) {
          setPlugins([]);
          setPendingApprovals([]);
          setFailures([
            {
              id: null,
              name: 'Plugins',
              reason: `Could not read installed plugins: ${formatCommandError(asCommandError(e))}`,
            },
          ]);
        }
      } finally {
        if (mountedRef.current) {
          setIsLoading(false);
        }
      }
    },
    [handleLifecycleError]
  );

  // Reload when project changes
  useEffect(() => {
    mountedRef.current = true;
    // Unload the previous project's plugins under the path they were loaded
    // with — the module cache is keyed by (path, id), so unloading with the
    // NEW path is a silent no-op that leaves the old modules' timers and
    // hooks alive, firing backend calls against a project where the plugin
    // isn't installed ("Plugin 'x' not found" toasts on project switch).
    const previousPath = currentPathRef.current;
    currentPathRef.current = projectPath;
    plugins.forEach((p) =>
      unloadPluginModule(previousPath || '', p.info.manifest.id, handleLifecycleError)
    );

    void loadAllPlugins(projectPath);

    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const reloadPlugins = useCallback(async () => {
    // Unload current plugins
    plugins.forEach((p) =>
      unloadPluginModule(projectPath || '', p.info.manifest.id, handleLifecycleError)
    );
    await loadAllPlugins(projectPath);
  }, [plugins, loadAllPlugins, projectPath, handleLifecycleError]);

  // Turning plugin developer mode on or off changes what may load.
  useEffect(() => {
    const onDevModeChanged = () => void reloadPlugins();
    window.addEventListener(PLUGIN_DEV_MODE_CHANGED_EVENT, onDevModeChanged);
    return () => window.removeEventListener(PLUGIN_DEV_MODE_CHANGED_EVENT, onDevModeChanged);
  }, [reloadPlugins]);

  const approvePending = useCallback(
    async (info: PluginInfo) => {
      if (!projectPath || !info.sha256) return;
      // Throws to the caller (the prompt toasts it); nothing loads on failure.
      await approvePlugin(projectPath, info.manifest.id, info.sha256);
      await reloadPlugins();
    },
    [projectPath, reloadPlugins]
  );

  const declinePending = useCallback(
    (info: PluginInfo) => {
      if (!projectPath) return;
      declinedThisSession.add(declineKey(projectPath, info));
      setPendingApprovals((current) =>
        current.filter((p) => declineKey(projectPath, p) !== declineKey(projectPath, info))
      );
    },
    [projectPath]
  );

  const getSlotPlugins = useCallback(
    (slotName: string): LoadedPlugin[] => {
      return plugins.filter(
        (p) => p.info.manifest.slots.includes(slotName) && p.module.slots[slotName]
      );
    },
    [plugins]
  );

  const trust = useMemo<PluginTrustApi>(
    () => ({ pending: pendingApprovals, approve: approvePending, decline: declinePending }),
    [pendingApprovals, approvePending, declinePending]
  );

  return {
    plugins,
    failures,
    trust,
    pendingApprovals,
    approvePending,
    declinePending,
    getSlotPlugins,
    reloadPlugins,
    isLoading,
  };
}
