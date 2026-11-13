/**
 * Web QA stand-in for expo-speech-recognition (see metro.config.js): a
 * scripted recognizer, so `pnpm qa:web` can show the composer listening,
 * with a moving waveform and words arriving, without a microphone.
 *
 * It "hears" one sentence a word at a time with a speech-like level, then
 * goes quiet (so the auto-stop after silence can be seen), and finalises it
 * on stop. `window.__qaDictation = { deny: true }` refuses permission;
 * `{ error: 'network' }` fails a second in; `{ long: true }` hears a paragraph
 * (over five lines), fast, to show how a long dictation wraps. A `qaSay`
 * in the page's address hears that sentence instead, from the first listen
 * (Talk's shots say "deploy" to get a card; a shot's globals come too late).
 */

type Listener = (e: unknown) => void;

const SENTENCE = 'Can you draft the launch email for Thursday, and send it to me first?'.split(' ');
const PARAGRAPH = (
  'Okay so for the launch on Thursday I want the email to go to everyone on the waitlist first, ' +
  'then the press list an hour later. Keep it short, lead with the pricing change, link the ' +
  'changelog, and make sure the unsubscribe footer is the new one legal approved last week. ' +
  'Send me a draft before noon so I can read it on the train.'
).split(' ');
const WORD_MS = 320;
/** The paragraph arrives faster, so a shot can catch all of it. */
const LONG_WORD_MS = 60;
const LEVEL_MS = 50;

const listeners = new Map<string, Set<Listener>>();
const emit = (name: string, e: unknown = {}) => listeners.get(name)?.forEach((l) => l(e));

let timers: ReturnType<typeof setTimeout>[] = [];
let running = false;
let heard = '';

type QaOptions = { deny?: boolean; error?: string; long?: boolean };

const said = (): string | null => {
  const search = (globalThis as unknown as { location?: { search?: string } }).location?.search;
  return search ? new URLSearchParams(search).get('qaSay') : null;
};
const qa = (): QaOptions =>
  (globalThis as unknown as { __qaDictation?: QaOptions }).__qaDictation ?? {};

function clear() {
  timers.forEach(clearTimeout);
  timers = [];
}

function finish(final: boolean) {
  if (!running) return;
  running = false;
  clear();
  if (final && heard) emit('result', { isFinal: true, results: [{ transcript: heard }] });
  emit('end');
}

export const ExpoSpeechRecognitionModule = {
  /** A script, not a recognizer: lib/dictation.ts keeps the analyzer out of its way. */
  scripted: true,
  supportsOnDeviceRecognition: () => true,
  isRecognitionAvailable: () => true,
  requestPermissionsAsync: () =>
    Promise.resolve({ granted: !qa().deny, status: qa().deny ? 'denied' : 'granted' }),
  start: () => {
    clear();
    running = true;
    heard = '';
    timers.push(setTimeout(() => emit('start'), 120));
    const fail = qa().error;
    if (fail) {
      timers.push(
        setTimeout(() => {
          emit('error', { error: fail, message: fail });
          finish(false);
        }, 1000)
      );
      return;
    }
    const say = said();
    const words = say ? say.split(' ') : qa().long ? PARAGRAPH : SENTENCE;
    const wordMs = qa().long ? LONG_WORD_MS : WORD_MS;
    const speechEnd = 300 + words.length * wordMs;
    // A voice: syllables riding on a slower swell, then the room.
    for (let t = 150; t < speechEnd + 6000; t += LEVEL_MS) {
      const speaking = t > 300 && t < speechEnd;
      const value = speaking
        ? 4 + 3.5 * Math.abs(Math.sin(t / 90)) * (0.6 + 0.4 * Math.sin(t / 700))
        : -1;
      timers.push(setTimeout(() => emit('volumechange', { value }), t));
    }
    words.forEach((_, i) => {
      timers.push(
        setTimeout(
          () => {
            heard = words.slice(0, i + 1).join(' ');
            emit('result', { isFinal: false, results: [{ transcript: heard }] });
          },
          300 + (i + 1) * wordMs
        )
      );
    });
  },
  stop: () => finish(true),
  abort: () => finish(false),
  addListener: (name: string, l: Listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(l);
    return { remove: () => listeners.get(name)?.delete(l) };
  },
};
