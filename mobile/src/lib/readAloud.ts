/**
 * Listen: an agent's reply read aloud by the phone's own voice (expo-speech:
 * AVSpeechSynthesizer on iOS, the system's TextToSpeech on Android). The words
 * never leave the phone to be spoken.
 *
 * What's read is the reply as you'd say it (`speakable`): markdown's marks
 * gone, a code block said as "code" rather than spelled out, a bare link said
 * as its site. One reply at a time; starting another stops the first. A bar
 * over the composer says it's reading, with Pause (iOS: Android's engine
 * can't pause) and Stop, and leaving the chat or the app stops it.
 *
 * **Silent mode.** On iOS the voice plays in the app's own audio session,
 * set to `soloAmbient` before each reading: the Ring/Silent switch mutes it,
 * as it mutes a game, and other audio pauses while it speaks. Dictation sets
 * the session for recording while it listens (expo-speech-recognition), so
 * it's set back here every time. Android has no silent switch for media: it
 * plays at media volume, which is what the bar's line says there.
 *
 * Expo Go and every build carry expo-speech, but it's loaded only when its
 * native half is there (as dictation's is), so a build without it just has
 * no Listen.
 */

import { requireOptionalNativeModule } from 'expo';
import { AppState, Platform, type NativeEventSubscription } from 'react-native';
import { create } from 'zustand';
import { plainText } from './actions';

type SpeechApi = typeof import('expo-speech');

function load(): SpeechApi | null {
  // The web build speaks through the browser's speechSynthesis.
  if (Platform.OS !== 'web' && !requireOptionalNativeModule('ExpoSpeech')) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-speech') as SpeechApi;
  } catch {
    return null;
  }
}

let speech: SpeechApi | null | undefined;
/** Tests only: the engine to use, or null for none. */
export function setSpeechForTests(api: SpeechApi | null | undefined) {
  speech = api;
}
const getSpeech = () => (speech === undefined ? (speech = load()) : speech);

/** Whether this build can read a reply aloud. */
export const canReadAloud = () => getSpeech() !== null;

/** Android's TextToSpeech takes 4,000 characters at a time; iOS has no limit. One size for both. */
export const SPEECH_CHUNK = 4000;

/** A reply as it's said: no marks, code as "code", a bare link as its site. */
export function speakable(markdown: string): string {
  const noCode = markdown.replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, '\n\nCode.\n\n');
  return plainText(noCode)
    .replace(/<?https?:\/\/(?:www\.)?([^/\s)>]+)[^\s)>]*>?/g, 'a link to $1')
    .replace(/^[ \t]*• /gm, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The words in pieces the engine takes, cut at a sentence's end (else a space) where it can. */
export function speechChunks(text: string, max = SPEECH_CHUNK): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const sentence = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
      window.lastIndexOf('\n')
    );
    const cut = sentence > max / 2 ? sentence + 1 : window.lastIndexOf(' ');
    const at = cut > 0 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export interface Reading {
  agentId: string;
  messageId: string;
  paused: boolean;
}

/** The reply being read now, if any. */
export const useReading = create<{ reading: Reading | null }>(() => ({ reading: null }));

const setReading = (reading: Reading | null) => useReading.setState({ reading });

/** Each reading's own number: a stopped one's late callbacks don't end the next. */
let session = 0;
let backgrounded: NativeEventSubscription | null = null;

/** iOS: the app's session muted by the Ring/Silent switch, for speech. */
function respectSilentMode() {
  if (Platform.OS !== 'ios') return;
  const recognizer = requireOptionalNativeModule<{
    setCategoryIOS?: (o: { category: string; categoryOptions: string[]; mode?: string }) => void;
  }>('ExpoSpeechRecognition');
  try {
    recognizer?.setCategoryIOS?.({ category: 'soloAmbient', categoryOptions: [], mode: 'default' });
  } catch {
    // The session as it is: still the app's own, which the system manages.
  }
}

/** Whether Pause is offered: Android's engine can only stop. */
export const canPause = () => Platform.OS !== 'android';

/** Read one reply aloud, stopping whatever was being read. False when this build can't. */
export function readAloud(agentId: string, messageId: string, markdown: string): boolean {
  const api = getSpeech();
  if (!api) return false;
  const parts = speechChunks(speakable(markdown));
  if (!parts.length) return false;
  const mine = ++session;
  void api.stop();
  respectSilentMode();
  setReading({ agentId, messageId, paused: false });
  const end = () => {
    if (session === mine) setReading(null);
  };
  parts.forEach((part, i) =>
    api.speak(part, {
      useApplicationAudioSession: true,
      onDone: i === parts.length - 1 ? end : undefined,
      onStopped: end,
      onError: end,
    })
  );
  // Leaving the app stops it: iOS would otherwise pause it mid-word and say nothing.
  backgrounded ??= AppState.addEventListener('change', (s) => {
    if (s === 'background') stopReading();
  });
  return true;
}

export function stopReading() {
  if (!useReading.getState().reading) return;
  session += 1;
  setReading(null);
  void getSpeech()?.stop();
}

export function pauseReading() {
  const now = useReading.getState().reading;
  if (!now || now.paused || !canPause()) return;
  setReading({ ...now, paused: true });
  void getSpeech()?.pause();
}

export function resumeReading() {
  const now = useReading.getState().reading;
  if (!now?.paused) return;
  setReading({ ...now, paused: false });
  void getSpeech()?.resume();
}

/** The bar over the composer while a reply in this chat is read. */
export function readingBar(reading: Reading | null, agentId: string) {
  if (!reading || reading.agentId !== agentId) return null;
  return {
    tone: 'active' as const,
    title: reading.paused ? 'Paused' : 'Reading aloud',
    detail:
      Platform.OS === 'android'
        ? 'Plays at media volume'
        : reading.paused
          ? 'Tap to carry on'
          : 'Tap to pause · silent mode mutes it',
  };
}
