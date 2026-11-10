/**
 * Talk: a hands-free conversation with one agent. The phone listens (the
 * same recognizer as the mic, on the phone when it can be), sends when you
 * stop talking, reads the reply aloud (the same voice as Listen), then
 * listens again, until you tap End or leave.
 *
 * Nothing here is new machinery: listening is `useDictation`, sending is
 * `send`, speaking is `readAloud`. This file is only the loop that joins
 * them, as a pure reducer so a test can walk every path:
 *
 *   listening → countdown → sending → waiting → speaking → listening
 *
 * - **listening**: the recognizer is on and the words stream in.
 * - **countdown**: you've been quiet `TALK_SILENCE_MS` after speaking; it
 *   sends after `TALK_COUNTDOWN_MS` unless you speak again (back to
 *   listening), tap Send now, or tap Cancel (the words are dropped and it
 *   listens again). The countdown is on screen, never silent.
 * - **sending**: the words are going to the Mac (the outbox if it's away).
 * - **waiting**: the agent is working; replies are read as each lands.
 * - **speaking**: a reply is read aloud. A tap skips it and listens.
 * - **paused**: the loop holds until you tap. Why is `pause`:
 *   - `approval`: a card waits. **Approvals are never answered by voice**:
 *     the loop stops listening, says so aloud once, and only a tap on the
 *     card goes on; Carry on does nothing while it waits;
 *   - `interrupted`: a call or another app took the microphone, or the app
 *     left the foreground;
 *   - `quiet`: it heard nothing for a while, so it stopped listening;
 *   - `problem`: the microphone couldn't be used or a send failed.
 * - **ended**: End, or leaving the screen.
 */

import type { AgentMessage } from '@shipstudio/companion-protocol';
import type { DictationProblem } from './dictation';
import { problemCopy } from './dictation';
import { speakable } from './readAloud';

/** Quiet this long after speaking starts the countdown. */
export const TALK_SILENCE_MS = 1200;
/** The countdown before it sends, on screen, with Send now and Cancel. */
export const TALK_COUNTDOWN_MS = 2000;
/**
 * Listening sessions in a row that heard nothing (each gives up after
 * `NOTHING_HEARD_MS`) before it stops listening and waits for a tap.
 */
export const QUIET_ROUNDS = 3;
/** How many of the conversation's last lines the screen shows. */
export const TALK_LINES = 4;

export type TalkPhase =
  | 'listening'
  | 'countdown'
  | 'sending'
  | 'waiting'
  | 'speaking'
  | 'paused'
  | 'ended';

export type TalkPause = 'approval' | 'interrupted' | 'quiet' | 'problem';

export interface TalkState {
  phase: TalkPhase;
  /** What it has heard of what you're saying now. */
  heard: string;
  /** When the countdown sends (countdown only). */
  sendAt: number | null;
  /** Replies still to read, oldest first (message ids). */
  queue: string[];
  /** The reply being read (speaking only). */
  speaking: string | null;
  /** The agent's turn is running: more may come. */
  busy: boolean;
  /** A card waits on you. */
  approval: boolean;
  pause: TalkPause | null;
  /** What went wrong, for `problem` and `interrupted`. */
  problem: string | null;
  /** Listening sessions in a row that heard nothing. */
  quietRounds: number;
}

export const TALK_START: TalkState = {
  phase: 'listening',
  heard: '',
  sendAt: null,
  queue: [],
  speaking: null,
  busy: false,
  approval: false,
  pause: null,
  problem: null,
  quietRounds: 0,
};

/** Talk opened on an agent: listening, unless it's working or a card waits. */
export function talkStart(busy: boolean, approval: boolean): TalkState {
  if (approval) return { ...TALK_START, busy, approval, phase: 'paused', pause: 'approval' };
  return { ...TALK_START, busy, phase: busy ? 'waiting' : 'listening' };
}

export type TalkEvent =
  /** The words so far (a partial or final result). */
  | { type: 'heard'; text: string }
  /** Quiet long enough after speaking: count down to sending. */
  | { type: 'silence'; now: number }
  /** A voice again during the countdown: keep listening. */
  | { type: 'voice' }
  /** The countdown ran out. */
  | { type: 'tick'; now: number }
  /** Send now: skip the rest of the countdown. */
  | { type: 'sendNow' }
  /** Cancel the countdown: drop the words, listen again. */
  | { type: 'cancel' }
  | { type: 'sent' }
  | { type: 'sendFailed'; message: string }
  /** A listening session ended having heard nothing. */
  | { type: 'nothingHeard' }
  /** The recognizer stopped with a problem. */
  | { type: 'micProblem'; problem: DictationProblem }
  /** A reply landed. */
  | { type: 'reply'; id: string }
  /** The reply `id` has been read (or was stopped). */
  | { type: 'spoken'; id: string }
  /** Tap while it reads: skip what's left and listen. */
  | { type: 'skip' }
  /** The agent's turn started or ended. */
  | { type: 'busy'; busy: boolean }
  /** A card waits on you, or no longer does. */
  | { type: 'approval'; waiting: boolean }
  /** A call, another app, or the app leaving the foreground. */
  | { type: 'interrupt'; reason?: string }
  /** Carry on after a pause (a tap). Never answers a card. */
  | { type: 'resume' }
  /** End. */
  | { type: 'end' };

/** Where the loop goes when nothing holds it: read what's waiting, wait on the turn, or listen. */
function next(s: TalkState): TalkState {
  if (s.queue.length) {
    const [first, ...rest] = s.queue;
    return { ...s, phase: 'speaking', speaking: first, queue: rest, pause: null, problem: null };
  }
  return {
    ...s,
    phase: s.busy ? 'waiting' : 'listening',
    speaking: null,
    heard: '',
    sendAt: null,
    pause: null,
    problem: null,
  };
}

const paused = (s: TalkState, pause: TalkPause, problem: string | null = null): TalkState => ({
  ...s,
  phase: 'paused',
  pause,
  problem,
  heard: '',
  sendAt: null,
  speaking: null,
});

const hearing = (s: TalkState) => s.phase === 'listening' || s.phase === 'countdown';

export function talkReducer(s: TalkState, e: TalkEvent): TalkState {
  if (s.phase === 'ended') return s;
  switch (e.type) {
    case 'heard':
      if (!hearing(s)) return s;
      return { ...s, heard: e.text, quietRounds: 0 };
    case 'silence':
      if (s.phase !== 'listening' || !s.heard.trim()) return s;
      return { ...s, phase: 'countdown', sendAt: e.now + TALK_COUNTDOWN_MS };
    case 'voice':
      return s.phase === 'countdown' ? { ...s, phase: 'listening', sendAt: null } : s;
    case 'tick':
      if (s.phase !== 'countdown' || s.sendAt == null || e.now < s.sendAt) return s;
      return { ...s, phase: 'sending', sendAt: null };
    case 'sendNow':
      if (!hearing(s) || !s.heard.trim()) return s;
      return { ...s, phase: 'sending', sendAt: null };
    case 'cancel':
      if (!hearing(s)) return s;
      return { ...s, phase: 'listening', heard: '', sendAt: null };
    case 'sent':
      if (s.phase !== 'sending') return s;
      // Sent: the turn starts on the Mac; until it says so, it's working.
      return { ...s, phase: 'waiting', heard: '', busy: true };
    case 'sendFailed':
      if (s.phase !== 'sending') return s;
      return paused(s, 'problem', e.message);
    case 'nothingHeard': {
      if (s.phase !== 'listening') return s;
      const quietRounds = s.quietRounds + 1;
      if (quietRounds >= QUIET_ROUNDS) return { ...paused(s, 'quiet'), quietRounds };
      return { ...s, quietRounds };
    }
    case 'micProblem':
      if (!hearing(s)) return s;
      if (e.problem === 'nothing-heard') return talkReducer(s, { type: 'nothingHeard' });
      return paused(
        s,
        e.problem === 'interrupted' ? 'interrupted' : 'problem',
        problemCopy(e.problem).text
      );
    case 'reply': {
      if (s.queue.includes(e.id) || s.speaking === e.id) return s;
      const queued = { ...s, queue: [...s.queue, e.id] };
      // Held by a card or a pause: read once you carry on.
      if (s.phase === 'paused' || s.phase === 'speaking') return queued;
      // A reply that lands while you talk (a turn you didn't start here) waits its turn.
      if (hearing(s) && s.heard.trim()) return queued;
      return next(queued);
    }
    case 'spoken':
      if (s.phase !== 'speaking' || s.speaking !== e.id) return s;
      return next({ ...s, speaking: null });
    case 'skip':
      if (s.phase !== 'speaking') return s;
      return { ...next({ ...s, queue: [], speaking: null, busy: false }), busy: s.busy };
    case 'busy': {
      const t = { ...s, busy: e.busy };
      // The turn ended with nothing more to read: your turn to talk.
      if (s.phase === 'waiting' && !e.busy && !s.queue.length) return next(t);
      return t;
    }
    case 'approval': {
      if (e.waiting) {
        if (s.approval && s.phase === 'paused') return s;
        // Whatever it was doing stops: what it was reading is read again after.
        const queue = s.speaking ? [s.speaking, ...s.queue] : s.queue;
        return paused({ ...s, approval: true, queue }, 'approval');
      }
      const t = { ...s, approval: false };
      return s.pause === 'approval' ? next(t) : t;
    }
    case 'interrupt':
      if (s.phase === 'paused') return s;
      return paused(
        { ...s, queue: s.speaking ? [s.speaking, ...s.queue] : s.queue },
        'interrupted',
        e.reason ?? null
      );
    case 'resume':
      if (s.phase !== 'paused' || s.approval) return s;
      return next({ ...s, quietRounds: 0 });
    case 'end':
      return { ...s, phase: 'ended', heard: '', sendAt: null, speaking: null, queue: [] };
  }
}

// ---- The clock -------------------------------------------------------------------

/**
 * What the passing of time does now, or null: quiet after speaking starts
 * the countdown, a voice during it goes back to listening, and its end sends.
 */
export function talkClock(
  s: TalkState,
  { now, lastVoiceAt }: { now: number; lastVoiceAt: number }
): TalkEvent | null {
  if (s.phase === 'listening') {
    if (s.heard.trim() && now - lastVoiceAt >= TALK_SILENCE_MS) return { type: 'silence', now };
    return null;
  }
  if (s.phase === 'countdown' && s.sendAt != null) {
    // A voice since the countdown began: you're still talking.
    if (lastVoiceAt > s.sendAt - TALK_COUNTDOWN_MS) return { type: 'voice' };
    if (now >= s.sendAt) return { type: 'tick', now };
  }
  return null;
}

/** Whole seconds left on the countdown, for the screen: "Sending in 2". */
export function secondsLeft(s: TalkState, now: number): number {
  if (s.phase !== 'countdown' || s.sendAt == null) return 0;
  return Math.max(1, Math.ceil((s.sendAt - now) / 1000));
}

/** How far through the countdown it is, 0..1. */
export function countdownProgress(s: TalkState, now: number): number {
  if (s.phase !== 'countdown' || s.sendAt == null) return 0;
  return Math.min(1, Math.max(0, 1 - (s.sendAt - now) / TALK_COUNTDOWN_MS));
}

// ---- What the screen and the voice say -------------------------------------------

/** The status line under the agent's key. */
export function talkStatus(s: TalkState, name: string, now: number): string {
  switch (s.phase) {
    case 'listening':
      return s.heard.trim() ? 'Listening' : 'Listening… go ahead';
    case 'countdown':
      return `Sending in ${secondsLeft(s, now)}`;
    case 'sending':
      return 'Sending';
    case 'waiting':
      return `${name} is working`;
    case 'speaking':
      return `${name} is speaking · tap to talk`;
    case 'paused':
      switch (s.pause) {
        case 'approval':
          return `${name} needs your OK`;
        case 'interrupted':
          return 'Paused';
        case 'quiet':
          return 'Stopped listening';
        default:
          return 'Paused';
      }
    case 'ended':
      return 'Ended';
  }
}

/** The line under the status while it's paused: why, and what a tap does. */
export function pauseDetail(s: TalkState): string | null {
  if (s.phase !== 'paused') return null;
  switch (s.pause) {
    case 'approval':
      return 'Approvals are answered with a tap, never by voice. Open the request, then Talk carries on.';
    case 'interrupted':
      return s.problem ?? 'The microphone was taken or the app left the screen. Tap Carry on.';
    case 'quiet':
      return 'Didn’t hear anything for a while. Tap Carry on to talk again.';
    case 'problem':
      return s.problem ?? 'Something went wrong. Tap Carry on to try again.';
    default:
      return null;
  }
}

/** Said aloud once when a card pauses Talk: the loop never answers it. */
export function approvalSpoken(name: string): string {
  return `${name} needs your OK. Tap the screen to look at it. I won’t answer it by voice.`;
}

/** Messages Talk reads aloud: the agent's replies and a failed turn's line. */
export const spokenKind = (m: AgentMessage) =>
  (m.kind === 'agent' || m.kind === 'error') && !!speakable(m.text);

/**
 * Replies that landed since Talk opened, in order, that haven't been taken:
 * `seen` holds every message id there when it opened, and each one handed on.
 */
export function newReplies(
  messages: AgentMessage[] | undefined,
  seen: ReadonlySet<string>
): AgentMessage[] {
  if (!messages) return [];
  return messages.filter((m) => !seen.has(m.id) && spokenKind(m));
}

export interface TalkLine {
  key: string;
  who: 'you' | 'agent';
  text: string;
}

/**
 * The last lines on screen: what you said and what it answered since Talk
 * opened, plus what it's hearing now, newest last.
 */
export function talkLines(
  messages: AgentMessage[] | undefined,
  since: number,
  heard: string,
  max = TALK_LINES
): TalkLine[] {
  const lines: TalkLine[] = (messages ?? [])
    .filter((m) => m.ts >= since && (m.kind === 'user' || spokenKind(m)))
    .map((m) => ({
      key: m.id,
      who: m.kind === 'user' ? ('you' as const) : ('agent' as const),
      text: m.kind === 'user' ? m.text : speakable(m.text),
    }));
  if (heard.trim()) lines.push({ key: 'heard', who: 'you', text: heard.trim() });
  return lines.slice(-max);
}
