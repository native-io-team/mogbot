/**
 * A note the app wrote that names one fix, with that fix as a button:
 * "Chrome isn't reachable through Claude's extension. Set up Your Chrome
 * once … · Set up Your Chrome" (`agents/chrome_health.rs`), "This Mac is
 * nearly out of disk space … · Free up space" (`agents/disk.rs`). The words
 * are the Mac's; the button opens where the fix is done, and its label is
 * shared with the phone (`noteFixLabel`).
 *
 * @module components/agents/AgentNoteFix
 */

import { useOpenModal } from '../../contexts/ModalContext';
import { noteFixLabel, type AgentMessage, type NoteFix } from '../../lib/agents';
import {
  requestSettingsSectionOnOpen,
  requestSettingsTabOnOpen,
  type SettingsSectionRequest,
} from '../../lib/settings';
import { TextButton } from '../primitives/TextButton';

export { noteFixLabel };

/** Where each fix is done: a part of Settings → Agents. */
const SECTION: Record<NoteFix, SettingsSectionRequest> = {
  user_chrome: 'agent-user-chrome',
  user_chrome_check: 'agent-user-chrome',
  disk: 'agent-disk',
};

export function NoteFixLine({ message, arrived }: { message: AgentMessage; arrived?: boolean }) {
  const openModal = useOpenModal();
  const fix = message.fix!;
  const open = () => {
    requestSettingsTabOnOpen('agents');
    requestSettingsSectionOnOpen(SECTION[fix] ?? 'agent-user-chrome');
    openModal('settings');
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
