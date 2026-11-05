/**
 * Dictation into the composer, on the phone's own recognizer and nowhere
 * else: `requiresOnDeviceRecognition`, so a phone that can't recognise
 * speech on the device keeps the mic off rather than send your voice to a
 * server. Nothing is recorded to a file, and what you say is only ever put
 * into the draft for you to read: it is never sent on its own.
 *
 * The recognizer is a native module (expo-speech-recognition), which Expo Go
 * doesn't carry. There `dictationSupport()` is `'no-module'` and the mic
 * points at the keyboard's own dictation instead; a development or release
 * build has it (docs/mobile.md, "Dictation").
 */

import { requireOptionalNativeModule } from 'expo';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

type Recognizer = typeof ExpoSpeechRecognitionModule;

/** Only loaded when the native half is in this build: importing it without one throws. */
function loadRecognizer(): Recognizer | null {
  if (!requireOptionalNativeModule('ExpoSpeechRecognition')) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('expo-speech-recognition') as typeof import('expo-speech-recognition'))
      .ExpoSpeechRecognitionModule;
  } catch {
    return null;
  }
}

let recognizer: Recognizer | null | undefined;
const getRecognizer = () =>
  recognizer === undefined ? (recognizer = loadRecognizer()) : recognizer;

/**
 * - `on-device`: the mic works, on this phone alone;
 * - `no-module`: this build has no recognizer (Expo Go): the keyboard's mic;
 * - `needs-network`: the phone would have to send audio away, so it's off.
 */
export type DictationSupport = 'on-device' | 'no-module' | 'needs-network';

export function dictationSupport(r: Recognizer | null = getRecognizer()): DictationSupport {
  if (!r) return 'no-module';
  try {
    return r.supportsOnDeviceRecognition() && r.isRecognitionAvailable()
      ? 'on-device'
      : 'needs-network';
  } catch {
    return 'needs-network';
  }
}

/** Spoken words after what was typed, with one space between (the desk's `joinDictation`). */
export function joinDictation(base: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return base;
  if (!base) return said;
  return /\s$/.test(base) ? base + said : `${base} ${said}`;
}

/** What the mic says when it can't listen, in a sentence for the hint line. */
export function dictationHint(support: DictationSupport): string | null {
  switch (support) {
    case 'no-module':
      return 'Use the mic on your keyboard to dictate.';
    case 'needs-network':
      return 'This phone can’t recognise speech on its own, so the mic stays off. Your voice never leaves the phone.';
    default:
      return null;
  }
}

export type DictationPhase = 'idle' | 'starting' | 'listening';

/**
 * The mic, for one draft. `start` asks for the microphone and speech
 * permission the first time; partial words appear in the draft as you speak,
 * and `stop` keeps them. `vocabulary` (the team's names) helps the
 * recognizer spell what you'll say most.
 */
export function useDictation({
  getDraft,
  setDraft,
  vocabulary,
  onProblem,
  recognizer: given,
}: {
  getDraft: () => string;
  setDraft: (text: string) => void;
  vocabulary: string[];
  onProblem: (text: string) => void;
  /** Tests only. */
  recognizer?: Recognizer | null;
}) {
  const r = given === undefined ? getRecognizer() : given;
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const base = useRef('');
  const active = useRef(false);
  const latest = useRef({ setDraft, onProblem });
  useEffect(() => {
    latest.current = { setDraft, onProblem };
  }, [setDraft, onProblem]);

  useEffect(() => {
    if (!r) return;
    const subs = [
      r.addListener('start', () => active.current && setPhase('listening')),
      r.addListener('result', (e) => {
        if (!active.current) return;
        const said = e.results[0]?.transcript ?? '';
        if (e.isFinal) {
          base.current = joinDictation(base.current, said);
          latest.current.setDraft(base.current);
        } else {
          latest.current.setDraft(joinDictation(base.current, said));
        }
      }),
      r.addListener('error', (e) => {
        if (!active.current) return;
        // Silence and a stop you asked for aren't problems.
        if (e.error !== 'aborted' && e.error !== 'no-speech') {
          latest.current.onProblem(
            e.error === 'not-allowed'
              ? 'Dictation needs the microphone and speech recognition. Allow them in Settings.'
              : e.error === 'language-not-supported' || e.error === 'service-not-allowed'
                ? 'This phone can’t recognise this language on its own, so dictation is off.'
                : 'Dictation stopped.'
          );
        }
      }),
      r.addListener('end', () => {
        active.current = false;
        setPhase('idle');
      }),
    ];
    return () => {
      subs.forEach((s) => s.remove());
      if (active.current) r.abort();
      active.current = false;
    };
  }, [r]);

  const start = useCallback(async () => {
    if (!r || active.current || dictationSupport(r) !== 'on-device') return false;
    setPhase('starting');
    const permission = await r.requestPermissionsAsync().catch(() => null);
    if (!permission?.granted) {
      setPhase('idle');
      latest.current.onProblem(
        'Dictation needs the microphone and speech recognition. Allow them in Settings.'
      );
      return false;
    }
    base.current = getDraft();
    active.current = true;
    r.start({
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
      // On the device or not at all: the reason this is the phone's own recognizer.
      requiresOnDeviceRecognition: true,
      contextualStrings: vocabulary.slice(0, 100),
      iosTaskHint: 'dictation',
    });
    return true;
  }, [r, getDraft, vocabulary]);

  const stop = useCallback(() => {
    if (!r || !active.current) return;
    r.stop();
  }, [r]);

  /** Stop and drop whatever is still on its way (the draft was just sent). */
  const cancel = useCallback(() => {
    if (!r || !active.current) return;
    active.current = false;
    r.abort();
    setPhase('idle');
  }, [r]);

  return { phase, start, stop, cancel, support: dictationSupport(r) };
}
