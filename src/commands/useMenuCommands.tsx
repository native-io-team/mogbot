import { CodeIcon, EditIcon, EyeIcon, PlusIcon, CloseIcon, TerminalIcon } from '@/components/icons';
import { useOptionalToast } from '../contexts/ToastContext';
import { runMenuAction } from '../lib/nativeMenu';
import { kbd } from '../lib/shortcuts';
import { isMac } from '../lib/setup';
import { openNewWindow } from '../lib/window';
import { asCommandError, formatCommandError } from '../lib/errors';
import { useCommands } from './useCommands';

/**
 * The palette's twins of menu-bar items that had no command of their own,
 * so every key in the menu is also findable in ⌘K (and works where there is
 * no menu bar). Each runs the same handler the menu item does
 * (`runMenuAction`). Items that already had a command carry their key on
 * it instead (New agent…, Settings, Search, Next agent that needs you…).
 */
export function useMenuCommands() {
  const { showToast } = useOptionalToast();
  useCommands(() => {
    const mac = isMac();
    const modes = [
      { n: 1, title: 'Workspace mode: Preview', icon: <EyeIcon size={14} /> },
      { n: 2, title: 'Workspace mode: Focus', icon: <TerminalIcon size={14} /> },
      { n: 3, title: 'Workspace mode: Code', icon: <CodeIcon size={14} /> },
    ];
    return [
      {
        id: 'window.new',
        title: 'New window',
        icon: <PlusIcon size={14} />,
        category: 'action' as const,
        keywords: ['window', 'another', 'second'],
        shortcut: mac ? kbd('mod', 'alt', 'N') : undefined,
        run: () =>
          void openNewWindow().catch((e: unknown) =>
            showToast(formatCommandError(asCommandError(e)), 'error')
          ),
      },
      {
        id: 'terminal.newTab',
        title: 'New terminal tab',
        icon: <PlusIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['terminal', 'agent', 'tab', 'session'],
        shortcut: kbd('mod', 'T'),
        run: () => runMenuAction('new_terminal_tab'),
      },
      {
        id: 'terminal.closeTab',
        title: 'Close terminal tab',
        icon: <CloseIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['terminal', 'agent', 'tab', 'close'],
        shortcut: kbd('mod', 'W'),
        run: () => runMenuAction('close_tab'),
      },
      ...modes.map((m) => ({
        id: `workspace.mode.${m.n}`,
        title: m.title,
        icon: m.icon,
        category: 'navigation' as const,
        when: 'project' as const,
        keywords: ['mode', 'layout', 'preview', 'focus', 'code', 'view'],
        // ⌘⌃1–3 exists on macOS only (elsewhere Ctrl is already the primary key).
        shortcut: mac ? kbd('mod', 'ctrl', String(m.n)) : undefined,
        run: () => runMenuAction(`switch_workspace_mode_${m.n}`),
      })),
      {
        id: 'preview.editMode',
        title: 'Toggle edit mode',
        icon: <EditIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['visual', 'edit', 'select', 'element', 'preview'],
        shortcut: kbd('mod', 'E'),
        run: () => runMenuAction('toggle_edit_mode'),
      },
      {
        id: 'preview.inspector',
        title: 'Toggle inspector',
        icon: <CodeIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['console', 'network', 'logs', 'devtools', 'inspect', 'preview'],
        shortcut: kbd('mod', 'I'),
        run: () => runMenuAction('toggle_inspector'),
      },
    ];
  }, [showToast]);
}
