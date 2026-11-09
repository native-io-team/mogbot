/**
 * The Chief opened a part of Settings (`settings_tools::EVENT_OPEN_SETTINGS`):
 * one page the user asked to see (`open_settings`), Slack's setup, where its
 * token goes into a masked field, or an engine account's sign-in. Only the main
 * window answers, so two windows don't both open Settings.
 *
 * @module hooks/useOpenSettingsFromChat
 */
import { useEffect, useState } from 'react';
import { useOpenModal } from '../contexts/ModalContext';
import { getWindowLabel } from '../lib/window';
import { requestSettingsSectionOnOpen, requestSettingsTabOnOpen } from '../lib/settings';
import { requestAccountsOnOpen } from '../lib/agentAccounts';
import { isSettingsPage } from '../lib/settingsPages';
import {
  onOpenSettings,
  requestAccountSignIn,
  type OpenSettingsRequest,
} from '../lib/settingsFromChat';

/** What opening Settings for `request` asks of it. Exported for tests. */
export function openSettingsFor(request: OpenSettingsRequest, open: () => void) {
  if (request.section === 'page') {
    // A page the Mac doesn't know (a newer Chief) opens Settings where it opens.
    requestSettingsTabOnOpen(isSettingsPage(request.page) ? request.page : 'agents');
    open();
    return;
  }
  requestSettingsTabOnOpen('agents');
  if (request.section === 'slack') {
    requestSettingsSectionOnOpen('agent-slack');
  } else {
    requestAccountsOnOpen('show');
    if (request.accountId) requestAccountSignIn(request.accountId);
  }
  open();
}

function isMain(): boolean {
  try {
    return getWindowLabel() === 'main';
  } catch {
    return false;
  }
}

export function useOpenSettingsFromChat() {
  const openModal = useOpenModal();
  const [isMainWindow] = useState(isMain);
  useEffect(() => {
    if (!isMainWindow) return;
    let off: (() => void) | undefined;
    let gone = false;
    try {
      onOpenSettings((request) => openSettingsFor(request, () => openModal('settings')))
        .then((u) => (gone ? u() : (off = u)))
        .catch(() => {});
    } catch {
      /* no event bridge (tests, the harness) */
    }
    return () => {
      gone = true;
      off?.();
    };
  }, [isMainWindow, openModal]);
}
