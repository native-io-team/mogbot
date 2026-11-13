/**
 * The phone's recognizer on iOS 26 and later: SpeechAnalyzer with
 * SpeechTranscriber (modules/speech-analyzer), Apple's newer on-device model,
 * which is more accurate than the SFSpeechRecognizer one and has no
 * one-minute limit. It's put in front of expo-speech-recognition as one
 * recognizer with that module's shape, so lib/dictation.ts is unchanged:
 *
 * - an on-device start goes to the analyzer when this locale's model is
 *   installed (`prepareAsync` says so); otherwise to the old recognizer, as
 *   before. A model that isn't here yet is asked for (AssetInventory) and
 *   used from the first start after it lands;
 * - a start through the platform's service (`requiresOnDeviceRecognition`
 *   false, the hook's fallback) always goes to the old recognizer;
 * - if the analyzer fails before hearing anything, the same start carries on
 *   in the old recognizer, on the phone, without the hook seeing the failure
 *   (its error and end are swallowed; the old one's start, results and end
 *   follow). The analyzer then isn't tried again until the app restarts.
 *
 * The team's names go to the analyzer as its context (`contextualStrings`);
 * whether SpeechTranscriber weighs them as the old recognizer does is
 * Apple's to decide.
 */

import type {
  ExpoSpeechRecognitionModule,
  ExpoSpeechRecognitionOptions,
} from 'expo-speech-recognition';
import type { SpeechAnalyzerNative, AnalyzerModelStatus } from '../../modules/speech-analyzer';

type Recognizer = typeof ExpoSpeechRecognitionModule;

/** What lib/dictation.ts uses of expo-speech-recognition's module, and all this provides. */
interface RecognizerLike {
  isRecognitionAvailable(): boolean;
  supportsOnDeviceRecognition(): boolean;
  requestPermissionsAsync(): ReturnType<Recognizer['requestPermissionsAsync']>;
  start(options: ExpoSpeechRecognitionOptions): void;
  stop(): void;
  abort(): void;
  addListener(name: string, listener: (event: never) => void): { remove(): void };
}

/** The events the hook listens to, from whichever recognizer is running. */
const EVENTS = ['start', 'result', 'audioend', 'volumechange', 'error', 'end'] as const;

/** Errors that end an analyzer session without trying the old recognizer. */
const NO_FAILOVER = new Set(['aborted', 'not-allowed']);

export function withSpeechAnalyzer(
  legacy: Recognizer,
  analyzer: SpeechAnalyzerNative | null
): Recognizer {
  let available = false;
  try {
    available = Boolean(analyzer?.isAvailable());
  } catch {
    available = false;
  }
  if (!analyzer || !available) return legacy;
  const a = analyzer;

  let status: AnalyzerModelStatus | null = null;
  /** Failed in this app run: the old recognizer from now on. */
  let broken = false;
  let checking = false;
  const check = () => {
    if (broken || checking || status === 'installed' || status === 'unsupported') return;
    checking = true;
    a.prepareAsync(null)
      .then((s) => {
        status = s;
      })
      .catch(() => {
        status = 'unavailable';
      })
      .finally(() => {
        checking = false;
      });
  };
  check();
  const ready = () => !broken && status === 'installed';

  type Listener = (e: never) => void;
  const listeners = new Map<string, Set<Listener>>();
  const fire = (name: string, e: unknown) =>
    listeners.get(name)?.forEach((l) => (l as (e: unknown) => void)(e));

  /** Which recognizer the current session runs on. */
  let active: 'analyzer' | 'legacy' = 'legacy';
  /** This session's options, to carry it on in the old recognizer. */
  let lastOptions: ExpoSpeechRecognitionOptions | null = null;
  /** The analyzer's session has reported words. */
  let heard = false;
  /** Stop or abort was asked for in this session. */
  let ending = false;
  /** The analyzer failed: its end starts the old recognizer instead of ending. */
  let failingOver = false;

  const fromAnalyzer = (name: string) => (e: unknown) => {
    if (active !== 'analyzer') return;
    if (name === 'result') {
      const said = (e as { results?: { transcript?: string }[] })?.results?.[0]?.transcript;
      if (said?.trim()) heard = true;
    }
    if (name === 'error') {
      const code = (e as { error?: string })?.error ?? '';
      if (!heard && !ending && !NO_FAILOVER.has(code)) {
        failingOver = true;
        broken = true;
        return;
      }
    }
    if (name === 'audioend' && failingOver) return;
    if (name === 'end') {
      if (failingOver && lastOptions && !ending) {
        failingOver = false;
        active = 'legacy';
        try {
          legacy.start(lastOptions);
          return;
        } catch {
          // Nothing to carry on in: end as the analyzer did.
        }
      }
      failingOver = false;
      check();
    }
    fire(name, e);
  };
  const fromLegacy = (name: string) => (e: unknown) => {
    if (active !== 'legacy') return;
    if (name === 'end') check();
    fire(name, e);
  };
  for (const name of EVENTS) {
    a.addListener(name, fromAnalyzer(name) as Listener);
    legacy.addListener(name, fromLegacy(name) as never);
  }

  const combined: RecognizerLike = {
    isRecognitionAvailable: () => ready() || legacy.isRecognitionAvailable(),
    supportsOnDeviceRecognition: () => ready() || legacy.supportsOnDeviceRecognition(),
    // The old module asks for both: the microphone and speech recognition.
    requestPermissionsAsync: () => legacy.requestPermissionsAsync(),
    start: (options) => {
      lastOptions = options;
      heard = false;
      ending = false;
      failingOver = false;
      const onDevice = options.requiresOnDeviceRecognition !== false;
      if (onDevice && ready()) {
        active = 'analyzer';
        a.start({
          locale: options.lang,
          contextualStrings: options.contextualStrings ?? [],
          volumeIntervalMillis: options.volumeChangeEventOptions?.intervalMillis ?? 50,
          ...(options.recordingOptions?.persist
            ? { recordSampleRate: options.recordingOptions.outputSampleRate ?? 16_000 }
            : {}),
        });
        return;
      }
      active = 'legacy';
      legacy.start(options);
    },
    stop: () => {
      ending = true;
      if (active === 'analyzer') a.stop();
      else legacy.stop();
    },
    abort: () => {
      ending = true;
      if (active === 'analyzer') a.abort();
      else legacy.abort();
    },
    addListener: (name, listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
      return { remove: () => listeners.get(name)?.delete(listener) };
    },
  };
  // Only the methods above are used (lib/dictation.ts); a native module can't be spread.
  return combined as unknown as Recognizer;
}
