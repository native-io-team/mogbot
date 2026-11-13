/**
 * Links in agent text: web links open in the system browser, never in the app
 * webview; a local path opens in its default app (⌘-click shows it in Finder
 * instead). The backend decides what is safe to open: folders, apps and
 * scripts are only ever revealed. Shared by replies, agent-to-agent threads
 * and a result card's summary.
 *
 * @module components/agents/useProseLinks
 */

import { useCallback, type MouseEvent } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { localPathFromHref, openLocalPath } from '../../lib/agents';

export function useProseLinks(agentId: string) {
  const { showToast } = useOptionalToast();
  return useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const anchor = (event.target as HTMLElement).closest('a');
      const href = anchor?.getAttribute('href');
      if (!href) return;
      event.preventDefault();
      if (/^(https?|mailto):/i.test(href)) {
        void openUrl(href);
        return;
      }
      const path = localPathFromHref(href);
      if (!path) return;
      const reveal = event.metaKey;
      openLocalPath(agentId, path, reveal).then(
        (done) => {
          if (done === 'reveal' && !reveal) showToast('Shown in Finder', 'info');
        },
        (error: unknown) => showToast(formatCommandError(asCommandError(error)), 'error')
      );
    },
    [agentId, showToast]
  );
}
