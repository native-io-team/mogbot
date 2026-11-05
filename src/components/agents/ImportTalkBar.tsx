/**
 * The bar above the Chief's composer while another assistant is importing
 * its agents over the connector (`agents/connector.rs`): where it's got to,
 * that the interview is separate from this chat, and a real Stop. Gone when
 * there's no import going.
 *
 * It says the state, not the question: the request itself is in the
 * conversation, and the bar never repeats it or points at "the card".
 * Stopping loses nothing (nothing is created until you import), so Stop is a
 * plain secondary button, not a red one.
 *
 * @module components/agents/ImportTalkBar
 */

import { Button } from '../primitives/Button';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { stopImportTalk, talkIsLive, type ImportTalk } from '../../lib/agents';
import { ConversationBar } from './AgentCard';
import { listOf } from './ImportParts';
import { useImportGate } from './ImportConnectorPanel';

/** The bar's two lines for each live state. */
export function barLines(talk: ImportTalk, chief: string): { title: string; detail: string } {
  switch (talk.state) {
    case 'awaiting_consent':
      return {
        title: `Import from ${talk.source} · Needs your OK`,
        detail: 'Nothing has been shared yet.',
      };
    case 'review':
      return {
        title: `Import from ${talk.source} · ready to review`,
        detail: 'Nothing is created until you import.',
      };
    default:
      return {
        title: `Importing from ${talk.source}${
          talk.staged.length ? ` · ${listOf(talk.staged)} staged for review` : ''
        }`,
        detail: `${talk.source} talks to a separate, sealed conversation, not this chat: what you type here stays between you and ${chief}.`,
      };
  }
}

export function ImportTalkBar({ chief }: { chief: string }) {
  const { talk } = useImportGate();
  const { showToast } = useOptionalToast();
  if (!talkIsLive(talk)) return null;
  const { title, detail } = barLines(talk, chief);
  const waiting = talk.state === 'awaiting_consent' || talk.state === 'review';
  return (
    <ConversationBar
      state={waiting ? 'waiting' : 'active'}
      data-testid="agent-import-talk"
      dataState={talk.state}
      title={title}
      detail={detail}
      actions={
        <Button
          variant="secondary"
          size="compact"
          onClick={() => {
            stopImportTalk().catch((e: unknown) =>
              showToast(formatCommandError(asCommandError(e)), 'error')
            );
          }}
        >
          Stop
        </Button>
      }
    />
  );
}
