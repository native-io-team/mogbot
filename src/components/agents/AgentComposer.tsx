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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { ArrowUpIcon, MicrophoneIcon, PaperclipIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import { TextButton } from '../primitives/TextButton';
import { TextArea } from '../primitives/TextField';
import { ComposerAttachments, ComposerQuotes } from './AgentAttachments';
import { ComposerRevising } from './AgentResult';
import { ComposerEditing } from './AgentGoBack';
import { AgentSecretHint } from './AgentSecretHint';
import { useMentionPicker } from './AgentMentions';
import type { DraftAttachment } from './useComposerAttachments';
import { sortAgents, type Agent, type ResultRef } from '../../lib/agents';
import { getAgentsSnapshot } from '../../lib/agentsStore';
import { setComposerDraft, useComposerDraft } from '../../lib/composerDraft';
import type { DictationPhase } from './useDictation';

/** A second Esc within this long stops a working agent; the first only says so. */
const ESC_CONFIRM_MS = 1500;

/** The parts of `useDictation` the composer drives. */
export interface ComposerDictation {
  phase: DictationPhase;
  toggle: () => void;
  cancel: () => void;
  onComposerKeyDown: (e: KeyboardEvent) => boolean;
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
  /** Editing a sent message (Edit and resend): its words as sent, or null. */
  editing?: string | null;
  onCancelEditing?: () => void;
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
  editing = null,
  onCancelEditing,
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
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Text added that still fits changes nothing: leave the height alone. Its
    // measuring pass (height `auto` and back) made the browser lay the whole
    // chat out again on every key, thousands of rows in a long one.
    const longer = lengthRef.current >= 0 && draft.length > lengthRef.current;
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
  }, [draft, inputRef]);

  return (
    <form
      className="agent-composer"
      data-dictation={dictation.phase}
      data-has-attachments={
        staged.length > 0 || quotes.length > 0 || revising !== null || editing !== null || undefined
      }
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      {mentionPicker.menu}
      <ComposerEditing text={editing} onCancel={() => onCancelEditing?.()} />
      <ComposerRevising revising={revising} onRemove={onClearRevising} />
      <ComposerQuotes quotes={quotes} onRemove={onRemoveQuote} />
      <ComposerAttachments items={staged} onRemove={onRemoveStaged} />
      <TextArea
        ref={inputRef}
        className="agent-composer__input"
        rows={1}
        value={draft}
        placeholder={dictating ? '' : `Message ${agentName}`}
        readOnly={dictating}
        onChange={(e) => {
          setDraft(e.target.value);
          mentionPicker.sync();
        }}
        onSelect={mentionPicker.sync}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (dictation.onComposerKeyDown(e)) return;
          if (mentionPicker.onKeyDown(e)) return;
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
            if (!blank) onSend(e.metaKey);
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
      />
      <div className="agent-composer__bar">
        {dictating ? (
          <span className="agent-composer__listening" role="status">
            <span className="agent-composer__listening-dot" aria-hidden />
            {dictation.phase === 'finishing' ? 'Finishing…' : 'Listening'}
            <span aria-hidden>·</span>
            <TextButton tabIndex={0} onClick={dictation.cancel}>
              Cancel
            </TextButton>
          </span>
        ) : (
          <IconButton
            tabIndex={0}
            variant="ghost"
            className="agent-composer__attach"
            icon={<PaperclipIcon size={14} />}
            onClick={onPickFiles}
            aria-label="Attach files"
            title="Attach files, or paste or drop them here"
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
        ) : (
          busy &&
          canSend &&
          !dictating && (
            <span className="agent-composer__hint" aria-hidden>
              ↵ queues · ⌘↵ interrupts and sends now
            </span>
          )
        )}
        <div className="agent-composer__actions">
          <IconButton
            ref={micRef}
            tabIndex={0}
            variant="ghost"
            className="agent-composer__mic"
            icon={<MicrophoneIcon size={14} />}
            onClick={dictation.toggle}
            disabled={dictation.phase === 'finishing'}
            aria-pressed={dictating}
            aria-label={dictating ? 'Stop dictating' : 'Dictate'}
            title={dictating ? 'Stop dictating (Esc to discard)' : 'Dictate (⌘⇧D, or hold ⌥Space)'}
          />
          {working && !canSend && !blank && !dictating ? (
            <IconButton
              tabIndex={0}
              variant="secondary"
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
              variant={canSend && !dictating ? 'primary' : 'secondary'}
              className="agent-composer__send"
              icon={<ArrowUpIcon size={14} />}
              disabled={!canSend || dictating}
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
