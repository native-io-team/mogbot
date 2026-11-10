import { useEffect, useRef } from 'react';
import { menuNumber, menuOwnsShortcuts, onMenuAction } from '../lib/nativeMenu';
import type { Account } from '../lib/accounts';

function digitFromEvent(event: KeyboardEvent): number | null {
  const codeMatch = /^Digit([1-9])$/.exec(event.code);
  if (codeMatch) return Number(codeMatch[1]);
  if (event.key.length === 1 && event.key >= '1' && event.key <= '9') {
    return Number(event.key);
  }
  return null;
}

interface Params {
  /** Workspaces in their account-picker order. */
  accounts: Account[];
  /** The workspace currently supplying the app's credentials. */
  activeAccountId: string | null;
  /** Activates a workspace and performs the caller's navigation cleanup. */
  handleSelectWorkspace: (account: Account) => void | Promise<void>;
}

/**
 * Global Option/Alt+1..9 shortcuts to jump to the Nth workspace.
 *
 * macOS registers the accelerator with the native menu so this still works
 * while the cross-origin preview iframe has focus. The account list is read
 * from a ref on every keystroke so workspace changes do not require a native
 * listener to be torn down and recreated.
 */
export function useWorkspaceNumberShortcuts({
  accounts,
  activeAccountId,
  handleSelectWorkspace,
}: Params): void {
  const latest = useRef({ accounts, activeAccountId, handleSelectWorkspace });

  useEffect(() => {
    latest.current = { accounts, activeAccountId, handleSelectWorkspace };
  }, [accounts, activeAccountId, handleSelectWorkspace]);

  useEffect(() => {
    let lastHandled: { index: number; at: number } | null = null;

    const switchWorkspace = (index: number): boolean => {
      if (!Number.isInteger(index) || index < 0 || index > 8) return false;

      const now = Date.now();
      if (lastHandled?.index === index && now - lastHandled.at < 250) return false;

      const {
        accounts: currentAccounts,
        activeAccountId: currentId,
        handleSelectWorkspace,
      } = latest.current;
      const account = currentAccounts[index];
      if (!account || account.id === currentId) return false;

      lastHandled = { index, at: now };
      void handleSelectWorkspace(account);
      return true;
    };

    const handler = (event: KeyboardEvent) => {
      // The macOS menu owns ⌥1…⌥9 (Go → Workspace), so it also works from
      // the cross-origin preview iframe. Elsewhere: Option-number key events
      // can expose a symbol as `key`, while `code` still identifies the
      // physical number row key.
      if (menuOwnsShortcuts()) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || !event.altKey) return;
      const digit = digitFromEvent(event);
      if (digit === null) return;

      if (!switchWorkspace(digit - 1)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handlePreviewMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (
        !data ||
        typeof data !== 'object' ||
        (data as { source?: unknown }).source !== 'shipstudio-inspect' ||
        (data as { type?: unknown }).type !== 'ss:workspaceShortcut'
      ) {
        return;
      }

      const index = Number((data as { index?: unknown }).index);
      switchWorkspace(index);
    };

    window.addEventListener('keydown', handler, { capture: true });
    window.addEventListener('message', handlePreviewMessage);
    const offMenu = onMenuAction((action) => {
      const n = menuNumber(action, 'switch_workspace');
      if (n !== null) switchWorkspace(n - 1);
    });

    return () => {
      window.removeEventListener('keydown', handler, { capture: true });
      window.removeEventListener('message', handlePreviewMessage);
      offMenu();
    };
  }, []);
}
