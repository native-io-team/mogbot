/**
 * The iOS 26 analyzer in front of expo-speech-recognition (lib/speechAnalyzer.ts):
 * on-device starts go to it once the locale's model is installed, everything
 * else to the old recognizer, and a failure before anything was heard carries
 * the same start on in the old one without the hook seeing it.
 */

import { withSpeechAnalyzer } from '../src/lib/speechAnalyzer';
import type { AnalyzerModelStatus, SpeechAnalyzerNative } from '../modules/speech-analyzer';

type Listener = (e: unknown) => void;

function emitter() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    fire: (name: string, e: unknown = {}) => listeners.get(name)?.forEach((l) => l(e)),
    addListener: (name: string, l: Listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(l);
      return { remove: () => listeners.get(name)!.delete(l) };
    },
  };
}

function fakeLegacy() {
  const e = emitter();
  return {
    ...e,
    isRecognitionAvailable: () => true,
    supportsOnDeviceRecognition: () => false,
    requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
  };
}

function fakeAnalyzer(statuses: AnalyzerModelStatus[], available = true) {
  const e = emitter();
  return {
    ...e,
    isAvailable: () => available,
    prepareAsync: jest.fn(() => Promise.resolve(statuses.shift() ?? 'installed')),
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const OPTIONS = {
  interimResults: true,
  continuous: true,
  requiresOnDeviceRecognition: true,
  contextualStrings: ['Juno', 'Mira'],
  volumeChangeEventOptions: { enabled: true, intervalMillis: 50 },
};

function wrap(legacy: ReturnType<typeof fakeLegacy>, analyzer: ReturnType<typeof fakeAnalyzer>) {
  const r = withSpeechAnalyzer(legacy as never, analyzer as unknown as SpeechAnalyzerNative);
  const seen: [string, unknown][] = [];
  for (const name of ['start', 'result', 'error', 'end', 'volumechange', 'audioend']) {
    r.addListener(name as never, ((e: unknown) => seen.push([name, e])) as never);
  }
  return { r, seen };
}

describe('withSpeechAnalyzer', () => {
  it('is the old recognizer itself where there is no analyzer (iOS < 26)', () => {
    const legacy = fakeLegacy();
    expect(withSpeechAnalyzer(legacy as never, null)).toBe(legacy);
    expect(withSpeechAnalyzer(legacy as never, fakeAnalyzer([], false) as never)).toBe(legacy);
  });

  it('listens on the analyzer once the model is installed, with the team’s names', async () => {
    const legacy = fakeLegacy();
    const analyzer = fakeAnalyzer(['installed']);
    const { r, seen } = wrap(legacy, analyzer);
    await flush();
    expect(r.supportsOnDeviceRecognition()).toBe(true);
    r.start(OPTIONS);
    expect(legacy.start).not.toHaveBeenCalled();
    expect(analyzer.start).toHaveBeenCalledWith({
      locale: undefined,
      contextualStrings: ['Juno', 'Mira'],
      volumeIntervalMillis: 50,
    });
    analyzer.fire('start');
    analyzer.fire('result', { isFinal: false, results: [{ transcript: 'hello' }] });
    legacy.fire('result', { isFinal: false, results: [{ transcript: 'stray' }] });
    r.stop();
    expect(analyzer.stop).toHaveBeenCalled();
    analyzer.fire('end');
    expect(seen.map(([n]) => n)).toEqual(['start', 'result', 'end']);
  });

  it('keeps the recording when asked, at the hook’s rate', async () => {
    const legacy = fakeLegacy();
    const analyzer = fakeAnalyzer(['installed']);
    const { r } = wrap(legacy, analyzer);
    await flush();
    r.start({ ...OPTIONS, recordingOptions: { persist: true, outputSampleRate: 16000 } });
    expect(analyzer.start).toHaveBeenCalledWith(
      expect.objectContaining({ recordSampleRate: 16000 })
    );
  });

  it('uses the old recognizer while the model downloads, and the analyzer once it’s in', async () => {
    const legacy = fakeLegacy();
    const analyzer = fakeAnalyzer(['downloading', 'installed']);
    const { r } = wrap(legacy, analyzer);
    await flush();
    r.start(OPTIONS);
    expect(legacy.start).toHaveBeenCalledWith(OPTIONS);
    expect(analyzer.start).not.toHaveBeenCalled();
    legacy.fire('end'); // asks again
    await flush();
    r.start(OPTIONS);
    expect(analyzer.start).toHaveBeenCalledTimes(1);
  });

  it('sends a start through the platform’s service to the old recognizer', async () => {
    const legacy = fakeLegacy();
    const analyzer = fakeAnalyzer(['installed']);
    const { r } = wrap(legacy, analyzer);
    await flush();
    r.start({ ...OPTIONS, requiresOnDeviceRecognition: false });
    expect(legacy.start).toHaveBeenCalled();
    expect(analyzer.start).not.toHaveBeenCalled();
  });

  it('carries a failed start on in the old recognizer, unseen, and stays there', async () => {
    const legacy = fakeLegacy();
    const analyzer = fakeAnalyzer(['installed']);
    const { r, seen } = wrap(legacy, analyzer);
    await flush();
    r.start(OPTIONS);
    analyzer.fire('error', { error: 'audio-capture', message: 'no model' });
    analyzer.fire('audioend', { uri: null });
    analyzer.fire('end');
    expect(legacy.start).toHaveBeenCalledWith(OPTIONS);
    expect(seen).toEqual([]);
    legacy.fire('start');
    legacy.fire('result', { isFinal: true, results: [{ transcript: 'hi' }] });
    legacy.fire('end');
    expect(seen.map(([n]) => n)).toEqual(['start', 'result', 'end']);
    r.start(OPTIONS);
    expect(analyzer.start).toHaveBeenCalledTimes(1);
    expect(legacy.start).toHaveBeenCalledTimes(2);
  });

  it('passes an error on once it has heard you, and never fails over a stop', async () => {
    const legacy = fakeLegacy();
    const analyzer = fakeAnalyzer(['installed']);
    const { r, seen } = wrap(legacy, analyzer);
    await flush();
    r.start(OPTIONS);
    analyzer.fire('result', { isFinal: false, results: [{ transcript: 'hello' }] });
    analyzer.fire('error', { error: 'interrupted' });
    analyzer.fire('end');
    expect(legacy.start).not.toHaveBeenCalled();
    expect(seen.map(([n]) => n)).toEqual(['result', 'error', 'end']);

    seen.length = 0;
    r.start(OPTIONS);
    r.abort();
    expect(analyzer.abort).toHaveBeenCalled();
    analyzer.fire('error', { error: 'audio-capture' });
    analyzer.fire('end');
    expect(legacy.start).not.toHaveBeenCalled();
    expect(seen.map(([n]) => n)).toEqual(['error', 'end']);
  });
});
