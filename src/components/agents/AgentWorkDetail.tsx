/**
 * Under the hood of a finished turn, desk only (`lib/agentDesk.ts`):
 *
 * - **Ran on.** "Claude Code · work@acme.com · claude-opus-4-6" beside the
 *   folded "What it did" line: the engine and account the Mac started the
 *   turn on, and the model only as the engine reported it.
 * - **Show exact command.** Under a step: the command line (or the tool and
 *   its input) exactly as it ran, redacted and scrubbed on the Mac, copyable.
 * - **What it was told.** The briefing the turn was given, section by
 *   section, read-only (`AgentBriefingModal`).
 *
 * None of this reaches the phone: the text lives on this Mac and only the
 * desk's commands read it.
 *
 * @module components/agents/AgentWorkDetail
 */

import { useState } from 'react';
import { CopyIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { getStepExact, getTurnBriefing, ranOnLine } from '../../lib/agentDesk';
import type { TurnWork } from '../../lib/agents';

/** Beside the folded line: what ran the turn, only as recorded. */
export function RanOn({ work }: { work: TurnWork }) {
  const line = ranOnLine(work);
  if (!line) return null;
  return (
    <span className="agent-work__ran-on" title={`Ran on ${line}`}>
      {line}
    </span>
  );
}

/** Where a step's exact command is kept: the line its turn ended on, and its index. */
export interface ExactRef {
  agentId: string;
  messageId: string;
  index: number;
}

/** A copy button for a block of text, with the shared toast. */
function CopyText({ text, label }: { text: string; label: string }) {
  const { showToast } = useOptionalToast();
  const { copy, isCopied } = useCopyToClipboard({ onCopy: () => showToast('Copied', 'success') });
  return (
    <TextButton tabIndex={0} leftIcon={<CopyIcon size={12} />} onClick={() => void copy(text)}>
      {isCopied ? 'Copied' : label}
    </TextButton>
  );
}

/** "Show exact command" under a step: read once, when first opened. */
export function ExactCommand({ at }: { at: ExactRef }) {
  const [open, setOpen] = useState(false);
  const read = useAsyncState(() => getStepExact(at.agentId, at.messageId, at.index));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && read.data === null && !read.isLoading) void read.execute();
  };
  return (
    <div className="agent-work__exact">
      <TextButton tabIndex={0} aria-expanded={open} onClick={toggle}>
        {open ? 'Hide exact command' : 'Show exact command'}
      </TextButton>
      {open &&
        (read.isLoading ? (
          <span className="agent-work__exact-note" role="status">
            <Spinner size="sm" /> Reading…
          </span>
        ) : read.error ? (
          <span className="agent-work__exact-note" role="alert">
            Couldn’t read it.{' '}
            <TextButton tabIndex={0} onClick={() => void read.execute()}>
              Try again
            </TextButton>
          </span>
        ) : read.data ? (
          <>
            <pre className="agent-work__exact-text">{read.data}</pre>
            <CopyText text={read.data} label="Copy" />
          </>
        ) : (
          <span className="agent-work__exact-note">It isn’t kept for this step any more.</span>
        ))}
    </div>
  );
}

/** "What it was told", under a finished turn's steps. */
export function BriefingLink({ agentId, messageId }: { agentId: string; messageId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="agent-work__files">
        <TextButton tabIndex={0} onClick={() => setOpen(true)}>
          What it was told
        </TextButton>
      </p>
      {open && (
        <AgentBriefingModal agentId={agentId} messageId={messageId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

const BRIEFING_DATE = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * The briefing a turn was given, read-only: the app's own sections, then the
 * agent's instructions and memory. `messageId` names the turn; without one,
 * the newest briefing any of its turns was given.
 */
export function AgentBriefingModal({
  agentId,
  agentName,
  messageId,
  onClose,
}: {
  agentId: string;
  agentName?: string;
  messageId?: string | null;
  onClose: () => void;
}) {
  // Settled once the first read came back, so "nothing kept" never flashes first.
  const [settled, setSettled] = useState(false);
  const read = useAsyncState(() => getTurnBriefing(agentId, messageId), {
    immediate: true,
    onSuccess: () => setSettled(true),
    onError: () => setSettled(true),
  });
  const briefing = read.data;
  const whole = briefing
    ? [
        ...briefing.sections.map((s) => `## ${s.title}\n\n${s.body}`),
        ...(briefing.instructions ? [`## Its instructions and memory\n\n${briefing.instructions}`] : []),
      ].join('\n\n')
    : '';
  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title={agentName ? `What ${agentName} was told` : 'What it was told'}
      className="agent-briefing"
      showCloseButton
      headerActions={whole ? <CopyText text={whole} label="Copy all" /> : undefined}
    >
      <div className="agent-briefing__body">
        {read.isLoading || !settled ? (
          <p className="agent-briefing__note" role="status">
            <Spinner size="sm" /> Reading…
          </p>
        ) : read.error ? (
          <p className="agent-briefing__note" role="alert">
            Couldn’t read it.{' '}
            <TextButton tabIndex={0} onClick={() => void read.execute()}>
              Try again
            </TextButton>
          </p>
        ) : !briefing ? (
          <p className="agent-briefing__note">
            {messageId
              ? 'This turn’s briefing isn’t kept: it ran before this was recorded, or it has been pruned.'
              : 'Nothing kept yet: the next turn’s briefing will be here.'}
          </p>
        ) : (
          <>
            <p className="agent-briefing__note">
              Given {BRIEFING_DATE.format(new Date(briefing.at))}. Written by the app on top of its
              own instructions; read-only. Secrets are blanked.
            </p>
            {briefing.sections.map((section, i) => (
              <details key={`${section.title}-${i}`} className="agent-briefing__section" open={i === 0}>
                <summary>{section.title}</summary>
                <pre className="agent-briefing__text">{section.body}</pre>
              </details>
            ))}
            {briefing.instructions && (
              <details className="agent-briefing__section">
                <summary>Its instructions and memory (CLAUDE.md)</summary>
                <pre className="agent-briefing__text">{briefing.instructions}</pre>
              </details>
            )}
          </>
        )}
      </div>
    </ModalFrame>
  );
}
