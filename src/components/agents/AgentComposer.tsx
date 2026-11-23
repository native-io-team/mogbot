/**
 * The agent chat's composer: the text, what waits above it (a result being
 * revised, quotes, files) and the bar under it (attach, dictate, send or
 * stop). It reads the draft itself (`useComposerDraft`), so typing re-renders
 * this and nothing of the conversation above it.
 *
 * Sending is the chat's (`onSend`): it reads the same draft when it goes.
 *
 * @module components/agents/AgentComposer
 */

import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { ArrowUpIcon, MicrophoneIcon, PlusIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import { TextArea } from '../primitives/TextField';
import { ComposerAttachments, ComposerQuotes } from './AgentAttachments';
import { ComposerRevising } from './AgentResult';
import { ComposerEditing, type UndoCode } from './AgentGoBack';
import { ReplyLine } from './ReplyChip';
import type { ReplyRef } from '../../lib/replyTo';
import { AgentSecretHint } from './AgentSecretHint';
import { useMentionPicker } from './AgentMentions';
import type { DraftAttachment } from './useComposerAttachments';
import { useInlineImages } from './useInlineImages';
import { sortAgents, type Agent, type ResultRef } from '../../lib/agents';
import { getAgentsSnapshot } from '../../lib/agentsStore';
import { setComposerDraft, useComposerDraft } from '../../lib/composerDraft';
import type { DictationMeter, DictationPhase } from './useDictation';
import { DictationLive } from './DictationLive';
import { noteQueueHintUse, queueHintLearned } from '../../lib/queueHint';

/** A second Esc within this long stops a working agent; the first only says so. */
const ESC_CONFIRM_MS = 1500;

/** The parts of `useDictation` the composer drives. */
export interface ComposerDictation {
  phase: DictationPhase;
  toggle: () => void;
  cancel: () => void;
  stopAndSend: (send: () => void) => void;
  onComposerKeyDown: (e: KeyboardEvent, send?: () => void) => boolean;
  /** This dictation as it's heard: the wave, the time, "Can't hear you". */
  meter: DictationMeter;
  /** Heard but couldn't be written out: Try again. */
  retry: (() => void) | null;
}

/** Send works while listening (it stops, then sends); not while tidying. */
export function sendDisabled(phase: DictationPhase, canSend: boolean): boolean {
  if (phase === 'listening' || phase === 'starting') return false;
  if (phase !== 'idle') return true;
  return !canSend;
}

interface AgentComposerProps {
  agentId: string;
  agentName: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  micRef: RefObject<HTMLButtonElement | null>;
  dictation: ComposerDictation;
  /** Who can be @mentioned here, in any order (sorted as the picker opens). */
  mentionSet: Agent[];
  staged: DraftAttachment[];
  onRemoveStaged: (id: string) => void;
  onPaste: (e: ClipboardEvent) => void;
  quotes: string[];
  onRemoveQuote: (index: number) => void;
  revising: ResultRef | null;
  onClearRevising: () => void;
  /** Replying to a message: the line at the top of the box, or null. */
  replying?: ReplyRef | null;
  onCancelReplying?: () => void;
  /** Editing a sent message (Edit and resend): its words as sent, or null. */
  editing?: string | null;
  onCancelEditing?: () => void;
  /** While editing: undoing the code in its copy too, when the Mac offers it. */
  editingCode?: UndoCode;
  /** Mid-turn: what's sent waits for the next one. */
  busy: boolean;
  /** Working, not just holding a card open: Stop is offered. */
  working: boolean;
  /** Esc: true if something above the chat (search) took it. */
  onEscape?: () => boolean;
  onStop: () => void;
  /** `now`: interrupt the turn in progress rather than queue (⌘↵). */
  onSend: (now?: boolean) => void;
  onPickFiles: () => void;
  /**
   * A starter's brief typed in with its blank still empty ("… My topics: "):
   * while the draft is exactly that, nothing sends (Send is off, Enter does
   * nothing) and the hint says to finish it.
   */
  unfilled?: string | null;
  /** The last message you sent in this chat, for ↑ in an empty composer. */
  lastSent?: () => string | null;
}

/**
 * The dictation line under the field: the wave and clock while listening,
 * "Tidying…", or "Couldn't write that out · Try again" (DictationLive).
 */
export function ListeningStatus({
  phase,
  meter,
  onCancel,
  onRetry,
}: {
  phase: DictationPhase;
  meter: DictationMeter;
  onCancel: () => void;
  onRetry?: (() => void) | null;
}) {
  return <DictationLive phase={phase} meter={meter} onCancel={onCancel} onRetry={onRetry} />;
}

/**
 * While dictating, keep the newest words in view: the field is read-only and
 * its value set from outside, so past its cap it would sit on the first lines.
 * When it ends (stopped, cancelled or cut off), the field takes focus with the
 * caret after the last word, so you can carry on typing or press Enter.
 */
export function useFollowDictation(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  draft: string,
  dictating: boolean
) {
  const wasDictating = useRef(dictating);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!dictating || !el) return;
    el.scrollTop = el.scrollHeight;
  }, [inputRef, draft, dictating]);
  useEffect(() => {
    const ended = wasDictating.current && !dictating;
    wasDictating.current = dictating;
    const el = inputRef.current;
    if (!ended || !el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    el.scrollTop = el.scrollHeight;
  }, [inputRef, dictating]);
}

/** True while the draft is the starter's brief with its blank still empty. */
export function isUnfilled(draft: string, unfilled: string | null | undefined): boolean {
  return Boolean(unfilled) && draft.trim() === (unfilled ?? '').trim();
}

/** "That looks like a key" over the composer, reading the draft itself. */
export function LiveSecretHint({ agentId, agentName }: { agentId: string; agentName: string }) {
  const draft = useComposerDraft(agentId);
  return (
    <AgentSecretHint
      agentId={agentId}
      agentName={agentName}
      draft={draft}
      setDraft={(text) => setComposerDraft(agentId, text)}
    />
  );
}

/** Narrower than this, the composer's placeholder is just "Message". */
const NARROW_COMPOSER_PX = 480;

export const AgentComposer = memo(function AgentComposer({
  agentId,
  agentName,
  inputRef,
  micRef,
  dictation,
  mentionSet,
  staged,
  onRemoveStaged,
  onPaste,
  quotes,
  onRemoveQuote,
  revising,
  onClearRevising,
  replying = null,
  onCancelReplying,
  editing = null,
  onCancelEditing,
  editingCode,
  busy,
  working,
  onEscape,
  onStop,
  onSend,
  onPickFiles,
  unfilled,
  lastSent,
}: AgentComposerProps) {
  const draft = useComposerDraft(agentId);
  const setDraft = useMemo(() => (text: string) => setComposerDraft(agentId, text), [agentId]);
  const dictating = dictation.phase !== 'idle';
  const blank = isUnfilled(draft, unfilled);
  const canSend = !blank && (draft.trim().length > 0 || staged.length > 0 || quotes.length > 0);

  // In sidebar order as it is now: computed again as you type, so the picker
  // opening on "@" lists them the way the sidebar does at that moment.
  const mentionable = useMemo(() => {
    const order = new Map(sortAgents(getAgentsSnapshot().agents).map((a, i) => [a.id, i]));
    return [...mentionSet].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }, [mentionSet, draft]); // eslint-disable-line react-hooks/exhaustive-deps -- `draft`: re-read the order as you type
  const mentionPicker = useMentionPicker(mentionable, inputRef, setDraft);
  // A new image goes in as [Image N] where the caret is (lib/inlineImages).
  const inline = useInlineImages({
    inputRef,
    items: staged,
    draft,
    setDraft,
    remove: onRemoveStaged,
  });

  // While it works and you've typed: ↵ queues, ⌘↵ interrupts. Said in a
  // quiet caption under the box until you've used both a few times
  // (lib/queueHint); the field's description says it for as long as it holds.
  const queueHintId = useId();
  const [learned, setLearned] = useState(queueHintLearned);
  // Holding a card open (not working), a message goes now: nothing to queue for.
  const queueing = busy && working && canSend && !dictating && !blank;
  const sendFromHere = (now: boolean) => {
    if (busy) setLearned(queueHintLearned(noteQueueHintUse(now)));
    onSend(now);
  };
  const queueSentence = `Enter queues it for when ${agentName} finishes. Command Enter interrupts ${agentName} and sends it now.`;

  // Esc stops a working agent only when pressed twice: the first says so,
  // quietly, where the hint goes. A reflex dismissal never drops a turn.
  const [escArmed, setEscArmed] = useState(false);
  useEffect(() => {
    if (!escArmed) return;
    const timer = window.setTimeout(() => setEscArmed(false), ESC_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [escArmed]);

  // Grow with the text, up to a cap, like a messaging app.
  const lengthRef = useRef(-1);
  const measuredTick = useRef(0);
  // Once the words wrap they move up to a row of their own, the whole width
  // of the box, and the tools go to a row underneath, as on the phone. They
  // stay up there until the box is empty, so the row never flips back and
  // forth as the wider field fits the same words on one line again.
  const [wrapped, setWrapped] = useState(false);
  // Under about 480px the box is narrow: the placeholder shortens to
  // "Message" so it stays on one line.
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [widthTick, setWidthTick] = useState(0);
  useLayoutEffect(() => {
    if (!form || typeof ResizeObserver === 'undefined') return;
    let width = form.clientWidth;
    const measure = () => {
      setNarrow(form.clientWidth < NARROW_COMPOSER_PX);
      // A new width wraps the words differently: measure the field again. A
      // height taken while the pane was opening (near zero wide, every letter
      // its own line) otherwise stayed at the eight-line cap.
      if (form.clientWidth !== width) {
        width = form.clientWidth;
        setWidthTick((t) => t + 1);
      }
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(form);
    return () => watch.disconnect();
  }, [form]);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (draft === '') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- layout measurement decides the row
      if (wrapped) setWrapped(false);
      // Empty is always one line: CSS's own height, never a measured one.
      lengthRef.current = 0;
      el.style.height = '';
      return;
    } else if (!wrapped) {
      const style = getComputedStyle(el);
      const oneLine =
        parseFloat(style.lineHeight) +
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom);
      if (el.scrollHeight > oneLine * 1.5) setWrapped(true);
    }
    // Text added that still fits changes nothing: leave the height alone. Its
    // measuring pass (height `auto` and back) made the browser lay the whole
    // chat out again on every key, thousands of rows in a long one.
    const longer =
      lengthRef.current >= 0 &&
      draft.length > lengthRef.current &&
      widthTick === measuredTick.current;
    measuredTick.current = widthTick;
    lengthRef.current = draft.length;
    // The cap is CSS's (about eight lines); past it the field scrolls.
    const cap = parseFloat(getComputedStyle(el).maxHeight) || 180;
    const previous = el.style.height;
    if (longer && previous) {
      if (parseFloat(previous) >= cap || el.scrollHeight <= el.clientHeight) return;
    }
    // Measure at `auto` with transitions off, put the old height back, then
    // set the new one, so the CSS height transition has a start to run from.
    el.style.transition = 'none';
    el.style.height = 'auto';
    const next = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.height = previous || next;
    void el.offsetHeight;
    el.style.transition = '';
    el.style.height = next;
  }, [draft, inputRef, wrapped, widthTick]);
  useFollowDictation(inputRef, draft, dictating);

  return (
    <form
      ref={setForm}
      className="agent-composer"
      data-wrapped={wrapped || undefined}
      data-narrow={narrow || undefined}
      data-queueing={(queueing && !learned) || undefined}
      data-dictation={dictation.phase}
      data-has-attachments={
        staged.length > 0 || quotes.length > 0 || revising !== null || editing !== null || undefined
      }
      onSubmit={(e) => {
        e.preventDefault();
        if (dictating) dictation.stopAndSend(() => sendFromHere(false));
        else sendFromHere(false);
      }}
    >
      {mentionPicker.menu}
      <ReplyLine replying={replying} onCancel={() => onCancelReplying?.()} />
      <ComposerEditing text={editing} code={editingCode} onCancel={() => onCancelEditing?.()} />
      <ComposerRevising revising={revising} onRemove={onClearRevising} />
      <ComposerQuotes quotes={quotes} onRemove={onRemoveQuote} />
      <ComposerAttachments items={staged} onRemove={inline.removeItem} />
      <TextArea
        ref={inputRef}
        className="agent-composer__input"
        rows={1}
        value={draft}
        placeholder={dictating ? '' : narrow ? 'Message' : `Message ${agentName}`}
        readOnly={dictating}
        onChange={(e) => {
          inline.onChange(e.target.value, e.target.selectionStart);
          mentionPicker.sync();
        }}
        onSelect={mentionPicker.sync}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (dictation.onComposerKeyDown(e, () => !blank && sendFromHere(e.metaKey))) return;
          if (mentionPicker.onKeyDown(e)) return;
          if (inline.onKeyDown(e)) return;
          if (
            e.key === 'ArrowUp' &&
            !e.shiftKey &&
            !e.altKey &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.nativeEvent.isComposing &&
            draft === '' &&
            staged.length === 0 &&
            quotes.length === 0 &&
            revising === null
          ) {
            // ↑ in an empty field brings back what you last sent, caret at
            // its end, as a terminal or Slack does. A field with anything in
            // it keeps ↑ for moving the caret.
            const last = lastSent?.();
            if (!last) return;
            e.preventDefault();
            setDraft(last);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.setSelectionRange(last.length, last.length));
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!blank) sendFromHere(e.metaKey);
          } else if (e.key === 'Escape' && onEscape?.()) {
            e.preventDefault();
          } else if (e.key === 'Escape' && working && !canSend) {
            e.preventDefault();
            if (escArmed) {
              setEscArmed(false);
              onStop();
            } else {
              setEscArmed(true);
            }
          }
        }}
        aria-label={`Message ${agentName}`}
        aria-describedby={queueing ? queueHintId : undefined}
      />
      <div className="agent-composer__bar">
        {/* The + (attach) stays while listening, so the text never moves. */}
        <IconButton
          tabIndex={0}
          variant="ghost"
          className="agent-composer__attach"
          icon={<PlusIcon size={14} />}
          onClick={onPickFiles}
          aria-label="Attach files"
          title="Attach files, or paste or drop them here"
        />
        {(dictating || dictation.retry) && (
          <ListeningStatus
            phase={dictation.phase}
            meter={dictation.meter}
            onCancel={dictation.cancel}
            onRetry={dictation.retry}
          />
        )}
        {/* Its own row above the text, so a long hint never squeezes it. */}
        {blank && !dictating ? (
          <span className="agent-composer__hint" role="status">
            Fill in the end, then send
          </span>
        ) : escArmed && working && !canSend && !dictating ? (
          <span className="agent-composer__hint" data-armed role="status">
            Esc again to stop {agentName}
          </span>
        ) : null}
        {queueing && (
          <p
            id={queueHintId}
            className="agent-composer__queue-hint"
            data-learned={learned || undefined}
          >
            <span className="sr-only">{queueSentence}</span>
            {!learned && (
              <span aria-hidden>
                <kbd className="agent-composer__key">↵</kbd> queue
                <span className="agent-composer__queue-dot">·</span>
                <kbd className="agent-composer__key">⌘↵</kbd> send now
              </span>
            )}
          </p>
        )}
        <div className="agent-composer__actions">
          {/* The mic stays in the box, typed into or not (composer "C"):
              dictating adds to what's there. */}
          <IconButton
            ref={micRef}
            tabIndex={0}
            variant="ghost"
            className="agent-composer__mic"
            icon={<MicrophoneIcon size={14} />}
            onClick={dictation.toggle}
            disabled={dictation.phase === 'finishing' || dictation.phase === 'tidying'}
            aria-pressed={dictating}
            aria-label={dictating ? 'Stop dictating' : 'Dictate'}
            title={dictating ? 'Stop dictating (Esc to discard)' : 'Dictate (⌘⇧D, or hold ⌥Space)'}
          />
          {working && !canSend && !blank && !dictating ? (
            <IconButton
              tabIndex={0}
              variant="default"
              className="agent-composer__stop"
              data-armed={escArmed || undefined}
              icon={<span className="agent-composer__stop-square" aria-hidden />}
              onClick={onStop}
              aria-label={`Stop ${agentName}`}
              title="Stop (Esc twice)"
            />
          ) : (
            <IconButton
              tabIndex={0}
              type="submit"
              variant="default"
              className="agent-composer__send"
              icon={<ArrowUpIcon size={14} />}
              disabled={sendDisabled(dictation.phase, canSend)}
              aria-label="Send"
              title={
                busy
                  ? `Queue it: ${agentName} reads it when it finishes (↵). Interrupt and send now: ⌘↵`
                  : 'Send'
              }
            />
          )}
        </div>
      </div>
    </form>
  );
});
