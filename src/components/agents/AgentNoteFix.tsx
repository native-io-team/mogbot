/**
 * A note the app wrote that names one fix, with that fix as a button:
 * "Chrome isn't reachable through Claude's extension. Set up Your Chrome
 * once … · Set up Your Chrome" (`agents/chrome_health.rs`). The words are
 * the Mac's; the button opens where the fix is done.
 *
 * @module components/agents/AgentNoteFix
 */

import { useOpenModal } from '../../contexts/ModalContext';
import type { AgentMessage, NoteFix } from '../../lib/agents';
import { requestSettingsSectionOnOpen, requestSettingsTabOnOpen } from '../../lib/settings';
import { TextButton } from '../primitives/TextButton';

/** The button's words for each fix. */
export function noteFixLabel(fix: NoteFix): string {
  switch (fix) {
    case 'user_chrome':
      return 'Set up Your Chrome';
  }
}

export function NoteFixLine({ message, arrived }: { message: AgentMessage; arrived?: boolean }) {
  const openModal = useOpenModal();
  const fix = message.fix!;
  const open = () => {
    switch (fix) {
      case 'user_chrome':
        requestSettingsTabOnOpen('agents');
        requestSettingsSectionOnOpen('agent-user-chrome');
        openModal('settings');
    }
  };
  return (
    <div
      className="agent-note"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
      data-fix={fix}
    >
      {message.text} ·{' '}
      <TextButton className="agent-note__link" onClick={open}>
        {noteFixLabel(fix)}
      </TextButton>
    </div>
  );
}
