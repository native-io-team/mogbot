/**
 * The bar above the Chief's composer while another assistant is importing
 * its agents over the connector (`agents/connector.rs`): where it's got to,
 * in one line of real counts, and a real Stop. Gone when there's no import
 * going.
 *
 * It says the state, not the question: the request itself is in the
 * conversation, and the bar never repeats it or points at "the card".
 * Stopping loses nothing (nothing is created until you import), so Stop is a
 * plain secondary button, not a red one.
 *
 * @module components/agents/ImportTalkBar
 */

import { Button } from '../primitives/Button';
import { TypingDots } from '../primitives/TypingDots';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { stopImportTalk, talkIsLive, type ImportTalk } from '../../lib/agents';
import { ConversationBar } from './AgentCard';
import { plural } from './ImportParts';
import { useImportGate } from './ImportConnectorPanel';

/**
 * The interview's progress in real counts, or null before there are any:
 * "2 agents staged · 37 conversations". Counts, never names (a list of names
 * grows and pushes the line about) and never a percentage (nothing knows how
 * many agents are still to come).
 */
export function importCounts(talk: ImportTalk): string | null {
  const parts = [
    talk.staged.length ? `${plural(talk.staged.length, 'agent')} staged` : null,
    talk.conversations ? plural(talk.conversations, 'conversation') : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The bar's words for each live state. While the interview runs it is one
 * line: who, then the counts. That the interview is a separate conversation
 * which can't see your chats is said once, by the note in the chat, not again
 * here.
 */
export function barLines(talk: ImportTalk): {
  title: string;
  detail?: string;
  counts?: string | null;
} {
  switch (talk.state) {
    case 'awaiting_consent':
      return {
        title: `Import from ${talk.source} · Needs your OK`,
        detail: 'Nothing has been shared yet.',
      };
    case 'playback':
      return {
        title: `Import from ${talk.source} · check the plan`,
        detail: 'Is anything missing? Nothing is created until you import.',
      };
    case 'review':
      return {
        title: `Import from ${talk.source} · ready to review`,
        detail: 'Nothing is created until you import.',
      };
    default:
      return { title: `Importing from ${talk.source}`, counts: importCounts(talk) };
  }
}

export function ImportTalkBar() {
  const { talk } = useImportGate();
  const { showToast } = useOptionalToast();
  if (!talkIsLive(talk)) return null;
  const { title, detail, counts } = barLines(talk);
  const waiting =
    talk.state === 'awaiting_consent' || talk.state === 'playback' || talk.state === 'review';
  return (
    <ConversationBar
      state={waiting ? 'waiting' : 'active'}
      // Going on: the same dots as an agent at work, not a blinking dot.
      icon={waiting ? undefined : <TypingDots />}
      data-testid="agent-import-talk"
      dataState={talk.state}
      title={
        waiting ? (
          title
        ) : (
          <span className="agent-import-talk__line">
            <span className="agent-import-talk__title">{title}</span>
            {counts && <span className="agent-import-talk__counts">{counts}</span>}
          </span>
        )
      }
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
