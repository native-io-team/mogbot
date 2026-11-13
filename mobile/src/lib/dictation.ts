/**
 * Dictation into the composer. Tap the mic and the field listens: the words
 * stream into it as you speak (the last few, still being decided, lighter),
 * a waveform follows your voice, and Stop (or a few seconds of silence) keeps
 * them in the draft to read and edit. Send stops and sends what's on screen
 * at once. × puts the draft back as it was. What you say is never sent
 * unless you press Send; that's the desk's rule too.
 *
 * Where the words are recognised: on the phone whenever it can (iOS and
 * Android 13+ with an on-device model), and otherwise by the platform's
 * speech service, off the phone; the field says so while it listens in that
 * case. The desk does the same (src-tauri/src/commands/dictation.rs). On
 * iOS 26+ "on the phone" is SpeechAnalyzer's transcriber when its model is
 * installed (lib/speechAnalyzer.ts), else the older on-device recognizer.
 *
 * The recognizer is a native module (expo-speech-recognition), which Expo Go
 * doesn't carry. There `dictationSupport()` is `'no-module'` and the mic
 * points at the keyboard's own dictation instead; a development or release
 * build has it (docs/mobile.md, "Dictation"). The web QA build swaps in a
 * scripted stand-in (dev/web/expo-speech-recognition.ts).
 *
 * **Hold to talk** (a voice message): hold the mic and it listens while you
 * hold; let go and what it heard is sent, as if you'd pressed Send once it
 * finished; slide away before letting go and nothing is sent (`held`,
 * `release`, `sendsOnRelease`, `holdEnds`). Silence never stops a hold that
 * has heard you: you decide when it ends. Only when Settings → Voice →
 * "Attach the recording" is on is the audio kept (`record`): a 16 kHz WAV in
 * the phone's cache, uploaded with the message to your own Mac and then
 * deleted here (`takeRecording`). Otherwise nothing is recorded to a file.
 *
 * The phases are a pure reducer (`dictationReducer`) so a test can walk
 * every path: idle → starting → listening → stopping → idle, with the way it
 * ended (`done`, `cancelled`, `sent`, `error`) and any problem to show.
 */

import { requireOptionalNativeModule } from 'expo';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { loadSpeechAnalyzer } from '../../modules/speech-analyzer';
import { withSpeechAnalyzer } from './speechAnalyzer';
import { LEVEL_INTERVAL_MS, levelFromVolume } from './waveform';

type Recognizer = typeof ExpoSpeechRecognitionModule;

/**
 * Only loaded when the native half is in this build: importing it without one
 * throws. On iOS 26+ the analyzer (lib/speechAnalyzer.ts) goes in front of it.
 */
function loadRecognizer(): Recognizer | null {
  // The web QA build resolves the package to a scripted stand-in.
  if (Platform.OS !== 'web' && !requireOptionalNativeModule('ExpoSpeechRecognition')) return null;
  let legacy: Recognizer;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    legacy = (require('expo-speech-recognition') as typeof import('expo-speech-recognition'))
      .ExpoSpeechRecognitionModule;
  } catch {
    return null;
  }
  // The scripted stand-in (QA) stays itself, so a simulator shows its script.
  if (Platform.OS !== 'ios' || (legacy as { scripted?: boolean }).scripted) return legacy;
  return withSpeechAnalyzer(legacy, loadSpeechAnalyzer());
}

let recognizer: Recognizer | null | undefined;
const getRecognizer = () =>
  recognizer === undefined ? (recognizer = loadRecognizer()) : recognizer;

// ---- What this phone can do ------------------------------------------------------

/**
 * - `on-device`: the mic works, and the words are recognised on this phone;
 * - `server`: the mic works, through the platform's speech service;
 * - `no-module`: this build has no recognizer (Expo Go): the keyboard's mic;
 * - `unavailable`: there's no recognizer on this phone right now.
 */
export type DictationSupport = 'on-device' | 'server' | 'no-module' | 'unavailable';

/**
 * Android builds an on-device recognizer only from API 33. On 31–32 the
 * module says it supports on-device recognition, but starts the default
 * recognizer (usually Google's service) with "prefer offline", which is a
 * hint rather than a promise. There it's `server`, and says so.
 */
export const ANDROID_ON_DEVICE_API = 33;

export function dictationSupport(
  r: Recognizer | null = getRecognizer(),
  platform: { OS: string; Version: number | string } = Platform
): DictationSupport {
  if (!r) return 'no-module';
  try {
    if (!r.isRecognitionAvailable()) return 'unavailable';
    if (platform.OS === 'android' && Number(platform.Version) < ANDROID_ON_DEVICE_API) {
      return 'server';
    }
    return r.supportsOnDeviceRecognition() ? 'on-device' : 'server';
  } catch {
    return 'unavailable';
  }
}

/** What the mic says when it can't listen, in a sentence for the hint line. */
export function dictationHint(support: DictationSupport): string | null {
  switch (support) {
    case 'no-module':
      return 'Use the mic on your keyboard to dictate.';
    case 'unavailable':
      return 'Speech recognition isn’t available on this phone right now.';
    default:
      return null;
  }
}

/**
 * The line over the field while it listens off the phone. iOS's server
 * recognition is Apple's; Android's is whichever service the phone has set,
 * so that one names nobody.
 */
export function listeningNote(
  via: 'on-device' | 'server',
  os: string = Platform.OS
): string | null {
  if (via !== 'server') return null;
  return os === 'ios' ? 'Recognised by Apple, off this phone' : 'Recognised off this phone';
}

// ---- Problems, in plain words with a fix -----------------------------------------

export type DictationProblem =
  | 'permission'
  | 'network'
  | 'busy'
  | 'interrupted'
  | 'microphone'
  | 'language'
  | 'unavailable'
  | 'nothing-heard'
  | 'failed';

/** The recognizer's error code as a problem worth a line, or null when it isn't one. */
export function problemFromError(code: string, heard: boolean): DictationProblem | null {
  switch (code) {
    // A stop you asked for.
    case 'aborted':
      return null;
    case 'no-speech':
    case 'speech-timeout':
      return heard ? null : 'nothing-heard';
    case 'not-allowed':
      return 'permission';
    case 'network':
      return 'network';
    case 'busy':
    case 'too-many-requests':
      return 'busy';
    case 'interrupted':
      return 'interrupted';
    case 'audio-capture':
      return 'microphone';
    case 'language-not-supported':
      return 'language';
    case 'service-not-allowed':
      return 'unavailable';
    default:
      return 'failed';
  }
}

export type ProblemFix = 'settings' | 'retry' | null;

export function problemCopy(problem: DictationProblem): { text: string; fix: ProblemFix } {
  switch (problem) {
    case 'permission':
      return { text: 'Dictation needs the microphone and speech recognition.', fix: 'settings' };
    case 'network':
      return {
        text: 'Dictation needs the internet on this phone. Check Wi-Fi or mobile data.',
        fix: 'retry',
      };
    case 'busy':
      return {
        text: 'Another app is using speech recognition. Try again in a moment.',
        fix: 'retry',
      };
    case 'interrupted':
      return { text: 'A call or another app took the microphone.', fix: 'retry' };
    case 'microphone':
      return { text: 'Dictation couldn’t start on this phone.', fix: 'retry' };
    case 'language':
      return {
        text: 'This phone can’t recognise speech in its language. Add a dictation language in Settings → General → Keyboard.',
        fix: null,
      };
    case 'unavailable':
      return { text: 'Speech recognition isn’t available on this phone right now.', fix: 'retry' };
    case 'nothing-heard':
      return { text: 'Didn’t catch anything.', fix: 'retry' };
    case 'failed':
      return { text: 'Dictation stopped unexpectedly.', fix: 'retry' };
  }
}

// ---- On the phone first --------------------------------------------------------

/** Where this session's words are being recognised. */
export type DictationVia = 'on-device' | 'server';

/**
 * Errors that mean the phone's own recognizer couldn't start (its model not
 * downloaded, "Failed to initialize recognizer", the language not on the
 * phone): before anything was heard, these try once more through the
 * platform's speech service rather than leave a dead mic.
 */
const ON_DEVICE_FAILURES = new Set([
  'audio-capture',
  'service-not-allowed',
  'language-not-supported',
]);

export function fallsBackToServer(code: string, via: DictationVia, heard: boolean): boolean {
  return via === 'on-device' && !heard && ON_DEVICE_FAILURES.has(code);
}

// ---- Text ------------------------------------------------------------------------

/** Spoken words after what was typed, with one space between (the desk's `joinDictation`). */
export function joinDictation(base: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return base;
  if (!base) return said;
  return /\s$/.test(base) ? base + said : `${base} ${said}`;
}

/**
 * How much of a partial result has settled: the words it shares with the
 * partial before, never including its last word (still being decided).
 * Returned as a length into `next.trim()`, ending at a word boundary.
 */
export function stablePrefix(prev: string, next: string): number {
  const a = prev.trim().split(/\s+/).filter(Boolean);
  const b = next.trim().split(/\s+/).filter(Boolean);
  let words = 0;
  while (words < b.length - 1 && words < a.length && a[words] === b[words]) words++;
  if (!words) return 0;
  // The length of the first `words` words of `next`, with the space after them.
  const said = next.trim();
  let at = 0;
  for (let i = 0; i < words; i++) {
    at = said.indexOf(b[i], at) + b[i].length;
  }
  while (at < said.length && /\s/.test(said[at])) at++;
  return at;
}

// ---- The state machine -----------------------------------------------------------

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'stopping';
export type DictationOutcome = 'done' | 'cancelled' | 'sent' | 'error';

export interface DictationState {
  phase: DictationPhase;
  /** The draft as it was when the mic was tapped: × puts it back. */
  original: string;
  /** The draft plus every final result so far. */
  committed: string;
  /** The current partial result, not yet final. */
  interim: string;
  /** How much of `interim.trim()` has settled (`stablePrefix`). */
  stable: number;
  /** Anything recognised this session. */
  heard: boolean;
  /** How the last session ended, until the next one starts. */
  outcome: DictationOutcome | null;
  problem: DictationProblem | null;
  /** Started by holding the mic: letting go sends what it heard. */
  held: boolean;
  /** The finger came off a held mic (and didn't slide away). */
  released: boolean;
}

export const DICTATION_IDLE: DictationState = {
  phase: 'idle',
  original: '',
  committed: '',
  interim: '',
  stable: 0,
  heard: false,
  outcome: null,
  problem: null,
  held: false,
  released: false,
};

export type DictationEvent =
  /** The mic was tapped (or held: `held`) with this draft. */
  | { type: 'request'; draft: string; held?: boolean }
  /** Permission refused, or no recognizer: it never started. */
  | { type: 'refused'; problem: DictationProblem }
  /** The recognizer is listening. */
  | { type: 'began' }
  | { type: 'result'; transcript: string; isFinal: boolean }
  /** Stop, or the silence after speech: keep what was heard, to edit. */
  | { type: 'stop' }
  /** The finger came off a held mic: stop, and send what it heard once it's in. */
  | { type: 'release' }
  /** Send while listening: keep what's on screen now, and stop at once. */
  | { type: 'send' }
  /** ×: put the draft back. */
  | { type: 'cancel' }
  /** The draft was sent: drop what's still on its way, leave the draft alone. */
  | { type: 'drop' }
  | { type: 'error'; code: string }
  /** The recognizer is done (always last). */
  | { type: 'end' };

const active = (s: DictationState) => s.phase !== 'idle';

/** Committed and interim as one draft. */
export function draftText(s: DictationState): string {
  return joinDictation(s.committed, s.interim);
}

/**
 * The draft split for the field: what's settled (typed, final, or the stable
 * start of a partial) in the body colour, and the words still being decided.
 * `settled + deciding` is always `draftText(s)`.
 */
export function dictationDisplay(s: DictationState): { settled: string; deciding: string } {
  const full = draftText(s);
  const tail = Math.max(0, s.interim.trim().length - s.stable);
  return { settled: full.slice(0, full.length - tail), deciding: full.slice(full.length - tail) };
}

export function dictationReducer(s: DictationState, e: DictationEvent): DictationState {
  switch (e.type) {
    case 'request':
      if (active(s)) return s;
      return {
        ...DICTATION_IDLE,
        phase: 'starting',
        original: e.draft,
        committed: e.draft,
        held: Boolean(e.held),
      };
    case 'refused':
      if (s.phase !== 'starting') return s;
      return { ...s, phase: 'idle', outcome: 'error', problem: e.problem };
    case 'began':
      return s.phase === 'starting' ? { ...s, phase: 'listening' } : s;
    case 'result': {
      if (s.phase !== 'listening' && s.phase !== 'stopping') return s;
      const heard = s.heard || e.transcript.trim().length > 0;
      if (e.isFinal) {
        return {
          ...s,
          heard,
          committed: joinDictation(s.committed, e.transcript),
          interim: '',
          stable: 0,
        };
      }
      return { ...s, heard, interim: e.transcript, stable: stablePrefix(s.interim, e.transcript) };
    }
    case 'stop':
      return s.phase === 'starting' || s.phase === 'listening' ? { ...s, phase: 'stopping' } : s;
    case 'release':
      if (!s.held || s.released) return s;
      // Ended by itself while still held (the recognizer's own limit): letting go sends it now.
      if (!active(s)) return s.outcome === 'done' ? { ...s, released: true } : s;
      return {
        ...s,
        released: true,
        phase: s.phase === 'starting' || s.phase === 'listening' ? 'stopping' : s.phase,
      };
    case 'cancel':
      if (!active(s)) return s;
      return {
        ...s,
        phase: 'idle',
        committed: s.original,
        interim: '',
        stable: 0,
        outcome: 'cancelled',
      };
    case 'send':
      if (!active(s)) return s;
      // The words on screen are what's sent: the partial too, as shown.
      return {
        ...s,
        phase: 'idle',
        committed: draftText(s),
        interim: '',
        stable: 0,
        outcome: 'sent',
      };
    case 'drop':
      if (!active(s)) return s;
      return { ...s, phase: 'idle', interim: '', stable: 0, outcome: 'sent' };
    case 'error': {
      if (!active(s)) return s;
      const problem = problemFromError(e.code, s.heard);
      if (!problem) return s;
      // What it heard stays: the words were on screen.
      return {
        ...s,
        phase: 'idle',
        committed: draftText(s),
        interim: '',
        stable: 0,
        outcome: 'error',
        problem,
      };
    }
    case 'end':
      if (!active(s)) return s;
      return {
        ...s,
        phase: 'idle',
        committed: draftText(s),
        interim: '',
        stable: 0,
        outcome: 'done',
        problem: s.heard ? null : 'nothing-heard',
      };
  }
}

// ---- Silence ---------------------------------------------------------------------

/** After this long without your voice, a dictation that heard you stops by itself. */
export const AUTO_STOP_SILENCE_MS = 3000;
/** A dictation that has heard nothing at all gives up after this long. */
export const NOTHING_HEARD_MS = 8000;
/** A level this loud counts as a voice, so a word the recognizer is slow on keeps it going. */
export const VOICE_LEVEL = 0.3;

/** Whether the silence so far should stop the mic. */
export function silenceStops({
  now,
  startedAt,
  lastVoiceAt,
  heard,
  holding = false,
}: {
  now: number;
  startedAt: number;
  lastVoiceAt: number;
  heard: boolean;
  /** The mic is being held: a pause isn't the end, letting go is. */
  holding?: boolean;
}): boolean {
  if (heard) {
    if (holding) return false;
    return now - Math.max(lastVoiceAt, startedAt) >= AUTO_STOP_SILENCE_MS;
  }
  return now - Math.max(lastVoiceAt, startedAt) >= NOTHING_HEARD_MS;
}

// ---- Holding the mic -------------------------------------------------------------

/** How a kept voice message is written: small enough to send (`MAX_ATTACHMENT_BYTES`). */
export const RECORDING = {
  persist: true,
  outputSampleRate: 16_000,
  outputEncoding: 'pcmFormatInt16',
} as const;
/** The name a voice message's audio has on the Mac. */
export const RECORDING_NAME = 'Voice message.wav';

/** Hold the mic this long and it's a voice message rather than a tap. */
export const HOLD_DELAY_MS = 300;
/** Let go this far from where the hold began and nothing is sent. */
export const HOLD_CANCEL_DISTANCE = 64;

/** Where the finger came off a held mic: on it sends, slid away cancels. */
export function holdEnds(
  from: { x: number; y: number },
  to: { x: number; y: number }
): 'send' | 'cancel' {
  return Math.hypot(to.x - from.x, to.y - from.y) > HOLD_CANCEL_DISTANCE ? 'cancel' : 'send';
}

/**
 * A held mic was let go and its words are all in: send the draft now. Only
 * when it ended cleanly having heard something; an error keeps the words in
 * the draft to read, as a tap's would.
 */
export function sendsOnRelease(s: DictationState): boolean {
  return s.held && s.released && s.phase === 'idle' && s.outcome === 'done' && s.heard;
}

// ---- The hook --------------------------------------------------------------------

/**
 * The mic, for one draft. `start` asks for the microphone and speech
 * permission the first time; words appear in the draft as you speak, `stop`
 * keeps them to edit, `send` keeps exactly what's on screen and stops at once
 * (the caller sends the draft), `cancel` puts the draft back, `drop` (after
 * a send) leaves it.
 * `vocabulary` (the team's names) helps the recognizer spell what you'll say
 * most. `onLevel` gets the voice's level, 0..1, about 20 times a second;
 * it's for a shared value, so nothing re-renders for it.
 */
export function useDictation({
  getDraft,
  setDraft,
  vocabulary,
  onLevel,
  recognizer: given,
  now = Date.now,
}: {
  getDraft: () => string;
  setDraft: (text: string) => void;
  vocabulary: string[];
  onLevel?: (level: number) => void;
  /** Tests only. */
  recognizer?: Recognizer | null;
  /** Tests only. */
  now?: () => number;
}) {
  const r = given === undefined ? getRecognizer() : given;
  const support = dictationSupport(r);
  const [state, setState] = useState<DictationState>(DICTATION_IDLE);
  const [startedAt, setStartedAt] = useState(0);
  const [via, setVia] = useState<DictationVia>('on-device');
  const viaRef = useRef<DictationVia>('on-device');
  /** The phone's recognizer failed to start: the next `end` starts the platform's. */
  const fallback = useRef(false);
  const stateRef = useRef(state);
  /** Sessions started on the recognizer whose `end` hasn't come: an old one's events are ignored. */
  const inFlight = useRef(0);
  /** This session keeps its audio (a held mic with "Attach the recording" on). */
  const recordRef = useRef(false);
  /** The kept audio's file, once the recognizer has finished writing it. */
  const recording = useRef<string | null>(null);
  const lastVoiceAt = useRef(0);
  const startedRef = useRef(0);
  const latest = useRef({ setDraft, onLevel, now });
  useEffect(() => {
    latest.current = { setDraft, onLevel, now };
  }, [setDraft, onLevel, now]);

  /** One step: the next state, and the draft written in the same tick, so it never lags. */
  const apply = useCallback((e: DictationEvent) => {
    const prev = stateRef.current;
    const next = dictationReducer(prev, e);
    if (next === prev) return prev;
    stateRef.current = next;
    setState(next);
    const was = draftText(prev);
    const is = draftText(next);
    if (next.outcome !== 'sent' && is !== was && (active(next) || active(prev))) {
      latest.current.setDraft(is);
    }
    if (!active(next)) latest.current.onLevel?.(0);
    return next;
  }, []);

  /** Start the recognizer, on the phone or through the platform's service. */
  const listen = useRef<(mode: DictationVia) => boolean>(() => false);
  useEffect(() => {
    listen.current = (mode) => {
      if (!r) return false;
      viaRef.current = mode;
      setVia(mode);
      // A session still on its way out: stop it for good before this one.
      if (inFlight.current > 0) r.abort();
      inFlight.current += 1;
      try {
        r.start({
          interimResults: true,
          continuous: true,
          addsPunctuation: true,
          // On the phone when it can be: what you say stays here.
          requiresOnDeviceRecognition: mode === 'on-device',
          contextualStrings: vocabulary.slice(0, 100),
          iosTaskHint: 'dictation',
          volumeChangeEventOptions: { enabled: true, intervalMillis: LEVEL_INTERVAL_MS },
          // Only when asked for: 16 kHz, 16-bit, about 2 MB a minute, under the Mac's 25 MB a file.
          ...(recordRef.current ? { recordingOptions: RECORDING } : {}),
        });
      } catch {
        inFlight.current = Math.max(0, inFlight.current - 1);
        apply({ type: 'refused', problem: 'failed' });
        return false;
      }
      return true;
    };
  }, [r, vocabulary, apply]);

  useEffect(() => {
    if (!r) return;
    // Only the newest session speaks: an aborted one can still report on its way out.
    const current = () => inFlight.current <= 1;
    const subs = [
      // Always the newest session's: an old one started long before.
      r.addListener('start', () => {
        const t = latest.current.now();
        lastVoiceAt.current = t;
        // A fallback to the platform's recognizer carries on the same session and clock.
        if (stateRef.current.phase === 'starting') {
          startedRef.current = t;
          setStartedAt(t);
        }
        const next = apply({ type: 'began' });
        // Stop before it had started: stop now that it has.
        if (next.phase === 'stopping') r.stop();
      }),
      r.addListener('result', (e) => {
        if (!current()) return;
        lastVoiceAt.current = latest.current.now();
        apply({ type: 'result', transcript: e.results[0]?.transcript ?? '', isFinal: e.isFinal });
      }),
      r.addListener('audioend', (e) => {
        if (!current() || !recordRef.current || !e?.uri) return;
        recording.current = e.uri;
      }),
      r.addListener('volumechange', (e) => {
        if (!current() || !active(stateRef.current)) return;
        const level = levelFromVolume(e.value);
        if (level >= VOICE_LEVEL) lastVoiceAt.current = latest.current.now();
        latest.current.onLevel?.(level);
      }),
      r.addListener('error', (e) => {
        if (!current()) return;
        const s = stateRef.current;
        const live = s.phase === 'starting' || s.phase === 'listening';
        if (live && fallsBackToServer(e.error, viaRef.current, s.heard)) {
          fallback.current = true;
          return;
        }
        apply({ type: 'error', code: e.error });
      }),
      r.addListener('end', () => {
        inFlight.current = Math.max(0, inFlight.current - 1);
        if (inFlight.current > 0) return;
        if (fallback.current) {
          fallback.current = false;
          const p = stateRef.current.phase;
          if (p === 'starting' || p === 'listening') {
            listen.current('server');
            return;
          }
        }
        apply({ type: 'end' });
      }),
    ];
    return () => {
      subs.forEach((s) => s.remove());
      if (active(stateRef.current)) r.abort();
    };
  }, [r, apply]);

  const phase = state.phase;

  // A few seconds without your voice keeps what you said; with nothing said, it gives up.
  useEffect(() => {
    if (phase !== 'listening' || !r) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const s = stateRef.current;
      if (s.phase !== 'listening') return;
      const stops = silenceStops({
        now: latest.current.now(),
        startedAt: startedRef.current,
        lastVoiceAt: lastVoiceAt.current,
        heard: s.heard,
        holding: s.held && !s.released,
      });
      if (stops) {
        apply({ type: 'stop' });
        r.stop();
        return;
      }
      timer = setTimeout(check, 250);
    };
    timer = setTimeout(check, 250);
    return () => clearTimeout(timer);
  }, [phase, r, apply]);

  /**
   * Listen; `held` for a voice message, which `release` sends, and `record`
   * to keep its audio for `takeRecording`.
   */
  const start = useCallback(
    async ({ held = false, record = false }: { held?: boolean; record?: boolean } = {}) => {
      if (!r || active(stateRef.current)) return false;
      const can = dictationSupport(r);
      if (can === 'no-module' || can === 'unavailable') return false;
      recordRef.current = held && record;
      recording.current = null;
      apply({ type: 'request', draft: getDraft(), held });
      setStartedAt(0); // the clock reads 0:00 until the recognizer is listening
      const permission = await r.requestPermissionsAsync().catch(() => null);
      if (stateRef.current.phase !== 'starting' && stateRef.current.phase !== 'stopping') {
        return false; // × while the permission sheet was up
      }
      if (!permission?.granted) {
        apply({ type: 'refused', problem: 'permission' });
        return false;
      }
      if (stateRef.current.phase === 'stopping') {
        // Stop before the recognizer started: nothing to keep.
        apply({ type: 'end' });
        return false;
      }
      return listen.current(can === 'on-device' ? 'on-device' : 'server');
    },
    [r, getDraft, apply]
  );

  /** The voice message's audio file, once (and only if it was kept): the caller owns it now. */
  const takeRecording = useCallback(() => {
    const uri = recording.current;
    recording.current = null;
    return uri;
  }, []);

  /** Stop: keep what it heard; the last words are still on their way, then it ends. */
  const stop = useCallback(() => {
    if (!r || !active(stateRef.current)) return;
    const before = stateRef.current.phase;
    apply({ type: 'stop' });
    if (before === 'listening') r.stop();
  }, [r, apply]);

  /**
   * The finger came off a held mic: like Stop, the last words still land,
   * and then `sendsOnRelease` is true for the caller to send the draft.
   */
  const release = useCallback(() => {
    if (!r) return;
    const before = stateRef.current.phase;
    apply({ type: 'release' });
    if (before === 'listening') r.stop();
  }, [r, apply]);

  /**
   * Send: what's on screen is the draft, now, and nothing more comes into it.
   * The recognizer is aborted rather than stopped: a final result arriving
   * after the send would land in the emptied field.
   */
  const send = useCallback(() => {
    if (!r || !active(stateRef.current)) return;
    const started = stateRef.current.phase !== 'starting';
    apply({ type: 'send' });
    if (started) r.abort();
  }, [r, apply]);

  /** ×: put the draft back as it was before the mic was tapped. */
  const cancel = useCallback(() => {
    if (!r || !active(stateRef.current)) return;
    const started = stateRef.current.phase !== 'starting';
    apply({ type: 'cancel' });
    if (started) r.abort();
  }, [r, apply]);

  /** The draft was sent: drop whatever is still on its way, and leave the draft alone. */
  const drop = useCallback(() => {
    if (!r || !active(stateRef.current)) return;
    const started = stateRef.current.phase !== 'starting';
    apply({ type: 'drop' });
    if (started) r.abort();
  }, [r, apply]);

  const clearProblem = useCallback(() => {
    if (!stateRef.current.problem) return;
    const next = { ...stateRef.current, problem: null };
    stateRef.current = next;
    setState(next);
  }, []);

  return {
    phase,
    state,
    display: dictationDisplay(state),
    startedAt,
    problem: state.problem,
    outcome: state.outcome,
    support,
    /** Where this session's words go: the phone's own recognizer, or the platform's. */
    via,
    start,
    stop,
    release,
    takeRecording,
    send,
    cancel,
    drop,
    clearProblem,
  };
}
