/**
 * The plugins control in the workspace header.
 *
 * Extracted from `WorkspaceView` so the split between hosting plugins (which
 * are native now and render nowhere) and the rest lives next to the dropdown
 * that cares about it, rather than inline in the header's prop object.
 *
 * @module components/plugins/WorkspacePluginsSlot
 */

import { useEffect, useMemo, useRef } from 'react';
import { PluginsDropdown } from './PluginsDropdown';
import { PluginTrustPrompt } from './PluginTrustPrompt';
import { useModal } from '../../contexts/ModalContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import { HOSTING_PLUGIN_IDS } from '../workspace/WorkspaceHeader';
import type { LoadedPlugin, PluginFailure, PluginTrustApi } from '../../hooks/usePlugins';
import type { PluginThemeData } from '../../contexts/PluginContext';
import type { ComponentProps } from 'react';

type DropdownProps = ComponentProps<typeof PluginsDropdown>;

interface WorkspacePluginsSlotProps {
  /** The plugin prop group, passed whole rather than unpacked at the call site. */
  plugins: {
    loadedPlugins: LoadedPlugin[];
    pluginFailures: PluginFailure[];
    pluginTrust: PluginTrustApi;
  };
  pluginProject: DropdownProps['pluginProject'];
  pluginActions: DropdownProps['pluginActions'];
  pluginTheme: PluginThemeData;
}

export function WorkspacePluginsSlot({
  plugins,
  pluginProject,
  pluginActions,
  pluginTheme,
}: WorkspacePluginsSlotProps) {
  const { loadedPlugins, pluginFailures, pluginTrust } = plugins;
  const pluginApprovals = pluginTrust.pending;
  // Opened through ModalContext rather than a callback threaded down from the
  // workspace — the documented way a component reaches a modal.
  const pluginManagerModal = useModal('pluginManager');
  const trustModal = useModal('pluginTrust');
  const openTrust = trustModal.open;
  const { showToast } = useOptionalToast();

  // One quiet toast per set of plugins waiting, not one per plugin and not a
  // dialog that opens by itself: the Plugins menu keeps the question after.
  const announced = useRef('');
  const waitingKey = pluginApprovals.map((p) => `${p.manifest.id}:${p.sha256}`).join('|');
  useEffect(() => {
    if (!waitingKey || announced.current === waitingKey) return;
    announced.current = waitingKey;
    const first = pluginApprovals[0];
    const message =
      pluginApprovals.length === 1
        ? first.trust === 'changed'
          ? `${first.manifest.name} changed. It won't load until you allow it.`
          : `This project wants to load the plugin ${first.manifest.name}.`
        : `This project wants to load ${pluginApprovals.length} plugins.`;
    showToast(message, 'info', { label: 'Review', onClick: openTrust });
  }, [waitingKey, pluginApprovals, showToast, openTrust]);
  // One pass rather than two filters over the same list on every render.
  const { regular, hostingCount } = useMemo(() => {
    const regularPlugins: LoadedPlugin[] = [];
    let hosting = 0;
    for (const plugin of loadedPlugins) {
      if (HOSTING_PLUGIN_IDS.includes(plugin.info.manifest.id)) hosting += 1;
      else regularPlugins.push(plugin);
    }
    return { regular: regularPlugins, hostingCount: hosting };
  }, [loadedPlugins]);

  return (
    <>
      <PluginsDropdown
        plugins={regular}
        failures={pluginFailures}
        waiting={pluginApprovals}
        onReviewWaiting={openTrust}
        hostingPluginCount={hostingCount}
        pluginProject={pluginProject}
        pluginActions={pluginActions}
        pluginTheme={pluginTheme}
        onOpenPluginManager={pluginManagerModal.open}
      />
      <PluginTrustPrompt
        pending={pluginApprovals}
        onAllow={pluginTrust.approve}
        onDecline={pluginTrust.decline}
      />
    </>
  );
}
