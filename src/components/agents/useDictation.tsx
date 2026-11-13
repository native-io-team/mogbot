/**
 * Dictation into the agent composer.
 *
 * Click the mic or press ⌘⇧D to toggle; hold ⌥Space in the composer to talk
 * while held. Escape cancels and puts back what was typed before. Spoken text
 * goes after whatever was already in the draft. Enter (or Send) while
 * listening stops and sends once the words are in.
 *
 * When it stops, the computer writes the words out again (Whisper, then a
 * pass that knows the team's names: src-tauri/src/voice): "Tidying…", then
 * the better words replace the live ones, with Undo for a few seconds. On
 * Windows and Linux there are no live words, only that.
 *
 * The level meter is written straight to a CSS variable on `meterRef`, so the
 * ~15 updates a second don't re-render the conversation.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { MicrophoneIcon } from '@/components/icons';
import { useCommands } from '../../commands/useCommands';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  cancelDictation,
  dictationOffError,
  joinDictation,
  onDictationEvent,
  onDictationModel,
  startDictation,
  stopDictation,
  type DictationBlock,
} from '../../lib/dictation';
import { asCommandError, formatCommandError } from '../../lib/errors';

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing' | 'tidying';

/** How long Undo stays after the words were written out again. */
export const UNDO_TIDY_MS = 8_000;

/** The words before the better ones replaced them, while Undo is offered. */
export interface TidyUndo {
  /** The whole draft to put back. */
  before: string;
  /** The draft as the better words left it (Undo only while it still is). */
  after: string;
}

interface Options {
  getDraft: () => string;
  /** Must be stable (a useState setter). */
  setDraft: (text: string) => void;
  /** Names worth recognising (agents, projects), read when dictation starts. */
  getVocabulary: () => Promise<string[]>;
  meterRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  /** The conversation so far, for the names pass (read when it starts). */
  getContext?: () => string;
}

export function useDictation({
  getDraft,
  setDraft,
  getVocabulary,
  meterRef,
  enabled,
  getContext,
}: Options) {
  const { showToast } = useOptionalToast();
  const [phase, setPhaseState] = useState<DictationPhase>('idle');
  const [blocked, setBlocked] = useState<DictationBlock | null>(null);
  const phaseRef = useRef<DictationPhase>('idle');
  const sessionRef = useRef<number | null>(null);
  /** The draft as typed before dictation began; cancel puts it back. */
  const originalRef = useRef('');
  /** The draft plus every finished segment; partials are appended to it. */
  const baseRef = useRef('');
  /** A stop or cancel asked for before the session id came back. */
  const pendingRef = useRef<'stop' | 'cancel' | null>(null);
  const holdingRef = useRef(false);
  /** Send once this dictation has ended (Enter or Send while listening). */
  const sendAfterRef = useRef<(() => void) | null>(null);
  /** The draft the live words last left, so better words replace only those. */
  const shownRef = useRef('');
  const [undo, setUndo] = useState<TidyUndo | null>(null);
  const [preparing, setPreparing] = useState<number | null>(null);

  const setPhase = useCallback((next: DictationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const setLevel = useCallback(
    (level: number) => meterRef.current?.style.setProperty('--dictation-level', String(level)),
    [meterRef]
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void onDictationEvent((event) => {
      if (event.session !== sessionRef.current) return;
      switch (event.kind) {
        case 'partial':
          shownRef.current = joinDictation(baseRef.current, event.text);
          setDraft(shownRef.current);
          break;
        case 'final':
          // A long dictation arrives as several segments; each final one
          // becomes part of what the next is appended to.
          baseRef.current = joinDictation(baseRef.current, event.text);
          shownRef.current = baseRef.current;
          setDraft(baseRef.current);
          break;
        case 'improving':
          setLevel(0);
          setPhase('tidying');
          break;
        case 'improved': {
          // Only over what the live words left: never over your own typing.
          const now = getDraft();
          if (now !== shownRef.current) break;
          const after = joinDictation(originalRef.current, event.text);
          if (after === now) break;
          setDraft(after);
          // Undo puts back the live words, or Whisper's own when there were none.
          const before =
            now === originalRef.current ? joinDictation(originalRef.current, event.raw) : now;
          // Going straight out (Enter while listening): nothing to undo.
          if (before !== after && !sendAfterRef.current) setUndo({ before, after });
          break;
        }
        case 'level':
          setLevel(event.level);
          break;
        case 'error':
          if (dictationOffError(event.message)) setBlocked('dictationOff');
          else showToast(event.message, 'error');
          break;
        case 'ended':
          if (event.cancelled && phaseRef.current !== 'finishing') {
            setDraft(originalRef.current);
            sendAfterRef.current = null;
          }
          sessionRef.current = null;
          holdingRef.current = false;
          setLevel(0);
          setPhase('idle');
          break;
      }
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
      if (sessionRef.current !== null) void cancelDictation(sessionRef.current);
    };
  }, [getDraft, setDraft, setLevel, setPhase, showToast]);

  // Enter or Send while listening: it goes once the words are in. After the
  // phase is idle (an effect), so the chat's send sees dictation over.
  useEffect(() => {
    if (phase !== 'idle' || !sendAfterRef.current) return;
    const send = sendAfterRef.current;
    sendAfterRef.current = null;
    send();
  }, [phase]);

  // Undo goes after a few seconds, or as soon as the draft is changed.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_TIDY_MS);
    return () => clearTimeout(t);
  }, [undo]);

  // Windows and Linux wait for the speech model the first time: say how far.
  useEffect(() => {
    if (blocked !== 'preparing') return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void onDictationModel((status) => {
      if (!alive) return;
      if (status.ready) {
        setBlocked(null);
        setPreparing(null);
      } else if (status.failed && !status.downloading) {
        setPreparing(null);
        setBlocked('modelFailed');
      } else {
        setPreparing(status.total ? status.received / status.total : 0);
      }
    }).then((fn) => (alive ? (unlisten = fn) : fn()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [blocked]);

  const undoTidy = useCallback(() => {
    if (undo && getDraft() === undo.after) setDraft(undo.before);
    setUndo(null);
  }, [undo, getDraft, setDraft]);

  const stop = useCallback(() => {
    holdingRef.current = false;
    if (phaseRef.current === 'starting') pendingRef.current = 'stop';
    if (phaseRef.current !== 'listening' || sessionRef.current === null) return;
    setPhase('finishing');
    setLevel(0);
    const session = sessionRef.current;
    // If the stop never reaches the Mac, no "ended" follows: keep what was
    // heard and give the field back rather than sit on "Finishing…".
    stopDictation(session).catch((error) => {
      if (sessionRef.current !== session) return;
      sessionRef.current = null;
      setPhase('idle');
      showToast(formatCommandError(asCommandError(error)), 'error');
    });
  }, [setLevel, setPhase, showToast]);

  const cancel = useCallback(() => {
    holdingRef.current = false;
    sendAfterRef.current = null;
    if (phaseRef.current === 'starting') pendingRef.current = 'cancel';
    const session = sessionRef.current;
    if (session === null) return;
    sessionRef.current = null;
    setDraft(originalRef.current);
    setLevel(0);
    setPhase('idle');
    void cancelDictation(session);
  }, [setDraft, setLevel, setPhase]);

  const start = useCallback(async () => {
    if (!enabled || phaseRef.current !== 'idle') return;
    originalRef.current = baseRef.current = shownRef.current = getDraft();
    pendingRef.current = null;
    sendAfterRef.current = null;
    setBlocked(null);
    setUndo(null);
    setPhase('starting');
    try {
      const vocabulary = await getVocabulary().catch(() => []);
      const result = await startDictation(vocabulary, getContext?.());
      if (result.status === 'blocked') {
        setBlocked(result.reason);
        setPhase('idle');
        return;
      }
      sessionRef.current = result.session;
      setPhase('listening');
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending === 'stop') stop();
      else if (pending === 'cancel') cancel();
    } catch (error) {
      setPhase('idle');
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  }, [enabled, getDraft, getVocabulary, getContext, setPhase, stop, cancel, showToast]);

  /** Stop listening and send once the words are in. */
  const stopAndSend = useCallback(
    (send: () => void) => {
      if (phaseRef.current === 'idle') return send();
      sendAfterRef.current = send;
      if (phaseRef.current === 'listening' || phaseRef.current === 'starting') stop();
    },
    [stop]
  );

  const toggle = useCallback(() => {
    if (phaseRef.current === 'idle') void start();
    else stop();
  }, [start, stop]);

  /**
   * Composer keys: hold ⌥Space to talk, Escape to cancel, Enter to stop and
   * send (with `send`; without, Enter only stops). True if handled.
   */
  const onComposerKeyDown = useCallback(
    (e: KeyboardEvent, send?: () => void) => {
      if (e.code === 'Space' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!e.repeat && phaseRef.current === 'idle') {
          holdingRef.current = true;
          void start();
        }
        return true;
      }
      if (e.key === 'Escape' && phaseRef.current !== 'idle') {
        e.preventDefault();
        cancel();
        return true;
      }
      // Enter while listening stops and sends once the last words are in
      // (and written out again). Shift+Enter only stops.
      if (e.key === 'Enter' && phaseRef.current !== 'idle') {
        e.preventDefault();
        if (send && !e.shiftKey) stopAndSend(send);
        else stop();
        return true;
      }
      return false;
    },
    [start, stop, cancel, stopAndSend]
  );

  // Releasing either key of the hold ends it; ⌘⇧D toggles from anywhere in
  // the chat. Window-level so a release outside the composer still counts.
  useEffect(() => {
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (holdingRef.current && (e.code === 'Space' || e.key === 'Alt')) stop();
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.code === 'KeyD' && !e.repeat) {
        e.preventDefault();
        toggle();
      }
    };
    const onBlur = () => {
      if (holdingRef.current) stop();
    };
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [stop, toggle]);

  useCommands(
    () =>
      enabled
        ? [
            {
              id: 'agents.dictate',
              title: phase === 'idle' ? 'Dictate a message' : 'Stop dictating',
              icon: <MicrophoneIcon size={14} />,
              category: 'action',
              shortcut: '⌘⇧D',
              keywords: ['voice', 'speak', 'microphone', 'speech', 'talk'],
              run: toggle,
            },
          ]
        : [],
    [enabled, phase, toggle]
  );

  return {
    phase,
    blocked,
    /** Windows and Linux, first use: how much of the speech model is here (0..1). */
    preparing,
    dismissBlocked: () => setBlocked(null),
    toggle,
    cancel,
    stopAndSend,
    onComposerKeyDown,
    /** Offered for a few seconds after better words replaced the live ones. */
    undo: undo ? undoTidy : null,
  };
}
