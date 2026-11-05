/**
 * The plugins control in the workspace header.
 *
 * Extracted from `WorkspaceView` so the split between hosting plugins (which
 * are native now and render nowhere) and the rest lives next to the dropdown
 * that cares about it, rather than inline in the header's prop object.
 *
 * @module components/plugins/WorkspacePluginsSlot
 */

import { useMemo } from 'react';
import { PluginsDropdown } from './PluginsDropdown';
import { PluginTrustPrompt } from './PluginTrustPrompt';
import { useModal } from '../../contexts/ModalContext';
import { HOSTING_PLUGIN_IDS } from '../workspace/WorkspaceHeader';
import type { LoadedPlugin, PluginFailure } from '../../hooks/usePlugins';
import type { PluginInfo } from '../../lib/plugins';
import type { PluginThemeData } from '../../contexts/PluginContext';
import type { ComponentProps } from 'react';

type DropdownProps = ComponentProps<typeof PluginsDropdown>;

interface WorkspacePluginsSlotProps {
  /** The plugin prop group, passed whole rather than unpacked at the call site. */
  plugins: {
    loadedPlugins: LoadedPlugin[];
    pluginFailures: PluginFailure[];
    /** Asked for by the project, not yet approved here (see PluginTrustPrompt). */
    pluginsPendingTrust?: PluginInfo[];
    reloadPlugins?: () => Promise<void>;
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
  const { loadedPlugins, pluginFailures, pluginsPendingTrust = [], reloadPlugins } = plugins;
  const projectPath = pluginProject?.path;
  // Opened through ModalContext rather than a callback threaded down from the
  // workspace — the documented way a component reaches a modal.
  const pluginManagerModal = useModal('pluginManager');
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
    <div className="plugin-trust-anchor">
      <PluginsDropdown
        plugins={regular}
        failures={pluginFailures}
        hostingPluginCount={hostingCount}
        pluginProject={pluginProject}
        pluginActions={pluginActions}
        pluginTheme={pluginTheme}
        onOpenPluginManager={pluginManagerModal.open}
      />
      {projectPath && pluginsPendingTrust.length > 0 && reloadPlugins && (
        <PluginTrustPrompt
          key={pluginsPendingTrust[0].manifest.id}
          projectPath={projectPath}
          pending={pluginsPendingTrust}
          onDecided={reloadPlugins}
        />
      )}
    </div>
  );
}
