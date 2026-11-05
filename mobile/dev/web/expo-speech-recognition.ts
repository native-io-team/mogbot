/**
 * Web QA stand-in for expo-speech-recognition (see metro.config.js): a
 * scripted recognizer, so `pnpm qa:web` can show the composer listening,
 * with a moving waveform and words arriving, without a microphone.
 *
 * It "hears" one sentence a word at a time with a speech-like level, then
 * goes quiet (so the auto-stop after silence can be seen), and finalises it
 * on stop. `window.__qaDictation = { deny: true }` refuses permission;
 * `{ error: 'network' }` fails a second in.
 */

type Listener = (e: unknown) => void;

const SENTENCE = 'Can you draft the launch email for Thursday, and send it to me first?'.split(' ');
const WORD_MS = 320;
const LEVEL_MS = 50;

const listeners = new Map<string, Set<Listener>>();
const emit = (name: string, e: unknown = {}) => listeners.get(name)?.forEach((l) => l(e));

let timers: ReturnType<typeof setTimeout>[] = [];
let running = false;
let heard = '';

type QaOptions = { deny?: boolean; error?: string };
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
    const speechEnd = 300 + SENTENCE.length * WORD_MS;
    // A voice: syllables riding on a slower swell, then the room.
    for (let t = 150; t < speechEnd + 6000; t += LEVEL_MS) {
      const speaking = t > 300 && t < speechEnd;
      const value = speaking
        ? 4 + 3.5 * Math.abs(Math.sin(t / 90)) * (0.6 + 0.4 * Math.sin(t / 700))
        : -1;
      timers.push(setTimeout(() => emit('volumechange', { value }), t));
    }
    SENTENCE.forEach((_, i) => {
      timers.push(
        setTimeout(
          () => {
            heard = SENTENCE.slice(0, i + 1).join(' ');
            emit('result', { isFinal: false, results: [{ transcript: heard }] });
          },
          300 + (i + 1) * WORD_MS
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
