/**
 * Dictation: on-device Apple speech recognition (src-tauri/src/commands/dictation.rs).
 *
 * `startDictation` either starts one session or says why it can't; the
 * session's text, loudness and end arrive as `dictation://event` events.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { BRAND } from '../lib/brand';
import { THIS_COMPUTER } from './computer';

export const DICTATION_EVENT = 'dictation://event';

export type DictationBlock =
  | 'microphone'
  | 'speechRecognition'
  | 'unavailable'
  | 'missingUsageDescription'
  // Not from the Mac's check: macOS's own Siri & Dictation switch is off,
  // which surfaces only once a session has started (`dictationOffError`).
  | 'dictationOff';

export type DictationStart =
  | { status: 'listening'; session: number }
  | { status: 'blocked'; reason: DictationBlock };

export type DictationEvent =
  | { kind: 'partial'; session: number; text: string }
  | { kind: 'final'; session: number; text: string }
  | { kind: 'level'; session: number; level: number }
  | { kind: 'error'; session: number; message: string }
  | { kind: 'ended'; session: number; cancelled: boolean };

/**
 * Names worth recognising: agents, and projects as they're said aloud
 * ("acme-marketing" → "acme marketing"). Duplicates are dropped here; the
 * backend trims and caps the list.
 */
export function dictationVocabulary(agentNames: string[], projectNames: string[]): string[] {
  const spoken = projectNames.map((name) => name.replace(/[-_.]+/g, ' ').trim());
  return [...new Set([...agentNames, ...spoken].filter(Boolean))];
}

export function startDictation(contextualStrings: string[]): Promise<DictationStart> {
  return invoke<DictationStart>('start_dictation', { contextualStrings });
}

export function stopDictation(session: number): Promise<void> {
  return invoke('stop_dictation', { session });
}

export function cancelDictation(session: number): Promise<void> {
  return invoke('cancel_dictation', { session });
}

export function onDictationEvent(handler: (event: DictationEvent) => void): Promise<UnlistenFn> {
  return listen<DictationEvent>(DICTATION_EVENT, (e) => handler(e.payload));
}

/** What to tell the user when dictation is blocked, and where to fix it. */
export function blockedCopy(reason: DictationBlock): { message: string; settings?: string } {
  switch (reason) {
    case 'microphone':
      return {
        message: `${BRAND.name} needs microphone access to dictate.`,
        settings: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      };
    case 'speechRecognition':
      return {
        message: `${BRAND.name} needs speech recognition access to dictate.`,
        settings:
          'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition',
      };
    case 'missingUsageDescription':
      return { message: 'This build can’t ask for microphone access.' };
    case 'unavailable':
      return { message: `Speech recognition isn’t available on ${THIS_COMPUTER} right now.` };
    case 'dictationOff':
      return {
        message: `Dictation is turned off on ${THIS_COMPUTER}. Turn it on in Keyboard settings, then try again.`,
        settings: 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension',
      };
  }
}

/**
 * True when a session's error is macOS saying its own Siri & Dictation switch
 * is off ("Siri and Dictation are disabled."): a setting to change, not a
 * fault, so it shows as the blocked line with its Settings button (issue #17).
 */
export function dictationOffError(message: string): boolean {
  return /siri and dictation are disabled|dictation is (disabled|turned off)/i.test(message);
}

export function openPrivacySettings(url: string): Promise<void> {
  return openUrl(url);
}

/** Put dictated text after what was already typed, with one space between. */
export function joinDictation(base: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return base;
  if (!base) return said;
  return /\s$/.test(base) ? base + said : `${base} ${said}`;
}
