/**
 * The local native module over iOS 26's SpeechAnalyzer + SpeechTranscriber
 * (ios/SpeechAnalyzerModule.swift). iOS only; null anywhere it isn't in the
 * build (Android, Expo Go, the web QA build, jest). lib/speechAnalyzer.ts
 * is the one place that uses it.
 */

import { requireOptionalNativeModule } from 'expo';

/** Where this phone's speech model for the locale is. */
export type AnalyzerModelStatus = 'installed' | 'downloading' | 'unsupported' | 'unavailable';

export interface AnalyzerStartOptions {
  /** BCP 47; the phone's own language when left out. */
  locale?: string;
  /** Words it should expect (the team's names). */
  contextualStrings?: string[];
  volumeIntervalMillis?: number;
  /** Keep the audio as a 16-bit mono WAV at this rate; `audioend` carries its uri. */
  recordSampleRate?: number;
}

/** The same events and payloads as expo-speech-recognition's. */
export interface SpeechAnalyzerNative {
  isAvailable(): boolean;
  prepareAsync(locale?: string | null): Promise<AnalyzerModelStatus>;
  start(options: AnalyzerStartOptions): void;
  stop(): void;
  abort(): void;
  addListener(name: string, listener: (event: never) => void): { remove(): void };
}

export function loadSpeechAnalyzer(): SpeechAnalyzerNative | null {
  try {
    return requireOptionalNativeModule<SpeechAnalyzerNative>('SpeechAnalyzer');
  } catch {
    return null;
  }
}
