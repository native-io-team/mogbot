/**
 * The Chief opened a part of Settings that needs the user's own hands on the
 * Mac (`settings_tools::EVENT_OPEN_SETTINGS`): Slack's setup, where its token
 * goes into a masked field, or an engine account's sign-in. Only the main
 * window answers, so two windows don't both open Settings.
 *
 * @module hooks/useOpenSettingsFromChat
 */
import { useEffect, useState } from 'react';
import { useOpenModal } from '../contexts/ModalContext';
import { getWindowLabel } from '../lib/window';
import { requestSettingsSectionOnOpen, requestSettingsTabOnOpen } from '../lib/settings';
import { requestAccountsOnOpen } from '../lib/agentAccounts';
import {
  onOpenSettings,
  requestAccountSignIn,
  type OpenSettingsRequest,
} from '../lib/settingsFromChat';

/** What opening Settings for `request` asks of it. Exported for tests. */
export function openSettingsFor(request: OpenSettingsRequest, open: () => void) {
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
