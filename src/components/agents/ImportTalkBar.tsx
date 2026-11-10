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
import { importQuietMinutes, stopImportTalk, talkIsLive, type ImportTalk } from '../../lib/agents';
import { useNow } from '../../hooks/useNow';
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
export function barLines(
  talk: ImportTalk,
  now = 0
): {
  title: string;
  detail?: string;
  counts?: string | null;
  /** The other assistant has the ball and hasn't come back. */
  quiet?: boolean;
} {
  const quiet = now ? importQuietMinutes(talk, now) : null;
  if (quiet !== null) {
    // Most often its chat turn ended (or its tool call timed out) and it
    // stopped calling back: only the user can nudge it.
    return {
      title: `Import from ${talk.source} · waiting on ${talk.source}`,
      detail: `Nothing from ${talk.source} for ${quiet} min. In ${talk.source}, say “carry on with the import”.`,
      counts: importCounts(talk),
      quiet: true,
    };
  }
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
  // Once a minute while an interview runs, so "waiting on Grok" appears
  // without an event (nothing happens: that's the point).
  const now = useNow(talk?.state === 'interviewing', 60_000);
  if (!talkIsLive(talk)) return null;
  const { title, detail, counts, quiet } = barLines(talk, now);
  const waiting =
    quiet ||
    talk.state === 'awaiting_consent' ||
    talk.state === 'playback' ||
    talk.state === 'review';
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
