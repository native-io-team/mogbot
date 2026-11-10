import { VariablesIcon } from '@/components/icons';
import { useCommands } from '../commands/useCommands';

interface Params {
  isAgentPanelHidden: boolean;
  toggleAgentPanel: () => void;
  isWebProject: boolean;
  variablesPanelOpen: boolean;
  toggleVariablesPanel: () => void;
  showPreviewLogs: boolean;
  togglePreviewLogs: () => void;
}

/**
 * Registers the workspace panel actions exposed by the Cmd+K palette.
 *
 * Docking and floating a panel are the layout's (`layout.dock.<panel>` in
 * useLayoutCommands, one per panel): this hook also registered "Float Agent
 * panel", "Float Elements panel" and "Dock Variables panel", so each showed
 * twice, word for word, running the same `setDocked`.
 */
export function useWorkspacePanelCommands({
  isAgentPanelHidden,
  toggleAgentPanel,
  isWebProject,
  variablesPanelOpen,
  toggleVariablesPanel,
  showPreviewLogs,
  togglePreviewLogs,
}: Params): void {
  useCommands(
    () => [
      {
        id: 'workspace.toggleAgentPanel',
        title: isAgentPanelHidden ? 'Show Session panel' : 'Hide Session panel',
        category: 'action',
        when: 'project',
        keywords: ['agent', 'terminal', 'claude', 'codex', 'pane', 'sidebar'],
        run: toggleAgentPanel,
      },
      {
        id: 'css.variables',
        title: variablesPanelOpen ? 'Hide Variables panel' : 'Show Variables panel',
        icon: <VariablesIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && isWebProject,
        keywords: ['css', 'variable', 'custom property', 'token', 'theme', '--'],
        run: toggleVariablesPanel,
      },
      {
        id: 'workspace.toggleInspector',
        title: showPreviewLogs ? 'Hide Inspector' : 'Show Inspector',
        category: 'action',
        when: 'project',
        keywords: ['preview', 'browser tools', 'logs', 'console', 'network'],
        run: togglePreviewLogs,
      },
    ],
    [
      isAgentPanelHidden,
      toggleAgentPanel,
      isWebProject,
      variablesPanelOpen,
      toggleVariablesPanel,
      showPreviewLogs,
      togglePreviewLogs,
    ]
  );
}
