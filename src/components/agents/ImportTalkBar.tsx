/**
 * The bar above the Chief's composer while another assistant is importing
 * its agents over the connector (`agents/connector.rs`): where it's got to,
 * that the interview is separate from this chat, and a real Stop. Gone when
 * there's no import going.
 *
 * @module components/agents/ImportTalkBar
 */

import { Button } from '../primitives/Button';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { stopImportTalk, talkIsLive, type ImportTalk } from '../../lib/agents';
import { listOf } from './ImportParts';
import { useImportGate } from './ImportConnectorPanel';

/** The bar's two lines for each live state. */
export function barLines(talk: ImportTalk, chief: string): { title: string; detail: string } {
  switch (talk.state) {
    case 'awaiting_consent':
      return {
        title: `${talk.source} wants to bring its agents over`,
        detail: 'Allow or deny it on the card above. Nothing has been shared.',
      };
    case 'review':
      return {
        title: `${talk.source}’s agents are ready for you to review`,
        detail: 'Nothing is created until you press Import on the card.',
      };
    default:
      return {
        title: `Importing from ${talk.source}${
          talk.staged.length ? ` · ${listOf(talk.staged)} staged for review` : ''
        }`,
        detail: `${talk.source} talks to a sealed interview, not this chat: what you type here stays between you and ${chief}.`,
      };
  }
}

export function ImportTalkBar({ chief }: { chief: string }) {
  const { talk } = useImportGate();
  const { showToast } = useOptionalToast();
  if (!talkIsLive(talk)) return null;
  const { title, detail } = barLines(talk, chief);
  return (
    <div
      className="agent-import-talk"
      role="status"
      data-testid="agent-import-talk"
      data-state={talk.state}
    >
      <span className="agent-import-talk__dot" aria-hidden />
      <span className="agent-import-talk__text">
        <strong>{title}</strong>
        <span className="agent-import-talk__detail">{detail}</span>
      </span>
      <Button
        variant="danger"
        size="compact"
        onClick={() => {
          stopImportTalk().catch((e: unknown) =>
            showToast(formatCommandError(asCommandError(e)), 'error')
          );
        }}
      >
        Stop import
      </Button>
    </div>
  );
}
