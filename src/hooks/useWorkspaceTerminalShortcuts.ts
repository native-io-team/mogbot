import { useEffect } from 'react';
import { isMac } from '../lib/setup';
import { menuNumber, menuOwnsShortcuts, onMenuAction } from '../lib/nativeMenu';
import type { ToastType } from './useToasts';
import type { TerminalTab } from './useTerminalManagement';

interface UseWorkspaceTerminalShortcutsParams {
  terminalTabs: TerminalTab[];
  activeTerminalTab: number;
  setActiveTerminalTab: (id: number) => void;
  addTerminalTab: () => void;
  closeTerminalTab: (id: number) => void;
  showToast: (message: string, type?: ToastType) => void;
}

/** Own the workspace shortcuts for adding, closing, and switching terminal tabs. */
export function useWorkspaceTerminalShortcuts({
  terminalTabs,
  activeTerminalTab,
  setActiveTerminalTab,
  addTerminalTab,
  closeTerminalTab,
  showToast,
}: UseWorkspaceTerminalShortcutsParams) {
  // Cmd/Ctrl+T adds a tab and Cmd/Ctrl+W closes the active tab.
  // Control+1-9 switches terminal/agent tabs; the F1-F10 range remains
  // available to the operating system and existing app controls.
  // On macOS the menu bar owns all three (File → New Terminal Tab / Close
  // Tab, Go → Terminal Tab), so they work from the preview's iframe too and
  // act once; its choices arrive through `onMenuAction`.
  useEffect(() => {
    const switchTerminalTab = (number: number) => {
      if (!Number.isInteger(number) || number < 1 || number > 9) return;

      const index = number - 1;
      const tab = terminalTabs[index];
      if (!tab) {
        // Guidance about a keystroke, not a malfunction — 'info' skips the
        // error-report pipeline (issue #437).
        showToast(`No terminal tab ${number} — you have ${terminalTabs.length} open`, 'info');
        return;
      }
      setActiveTerminalTab(tab.id);
    };

    const closeTab = () => {
      if (terminalTabs.length > 1) closeTerminalTab(activeTerminalTab);
    };

    function handleKeyDown(e: KeyboardEvent) {
      if (menuOwnsShortcuts()) return;
      // Cmd+W — close active terminal tab (instead of closing the window)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 'w') {
        e.preventDefault();
        closeTab();
        return;
      }

      // Cmd+T — new tab
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 't') {
        e.preventDefault();
        addTerminalTab();
        return;
      }

      // Control+1-9 is intentionally distinct from Cmd+Control+1-3, which
      // belongs to workspace modes. On non-macOS, add Alt because Ctrl+1-9
      // is the platform's primary-modifier equivalent used for projects.
      const isTerminalNumberShortcut = isMac()
        ? e.ctrlKey && !e.metaKey && !e.altKey
        : e.ctrlKey && e.altKey && !e.metaKey;
      if (!isTerminalNumberShortcut || e.shiftKey) return;
      const num = Number(e.key);
      if (!Number.isInteger(num) || num < 1 || num > 9) return;
      e.preventDefault();
      switchTerminalTab(num);
    }
    window.addEventListener('keydown', handleKeyDown);
    const offMenu = onMenuAction((action) => {
      const n = menuNumber(action, 'switch_terminal');
      if (n !== null) switchTerminalTab(n);
      else if (action === 'close_tab') closeTab();
      else if (action === 'new_terminal_tab') addTerminalTab();
    });
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      offMenu();
    };
  }, [
    terminalTabs,
    activeTerminalTab,
    addTerminalTab,
    closeTerminalTab,
    setActiveTerminalTab,
    showToast,
  ]);
}
