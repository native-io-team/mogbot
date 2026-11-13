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
  // Windows and Linux, first use: the speech model is being fetched (once).
  | 'preparing'
  // That fetch failed (no connection): Try again.
  | 'modelFailed'
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
  | { kind: 'improving'; session: number }
  | { kind: 'improved'; session: number; text: string; raw: string; tidied: boolean }
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

/**
 * Start listening. `context` is the conversation so far, for the pass that
 * fixes names once it stops.
 */
export function startDictation(
  contextualStrings: string[],
  context?: string
): Promise<DictationStart> {
  return invoke<DictationStart>('start_dictation', { contextualStrings, context: context ?? null });
}

export const DICTATION_MODEL_EVENT = 'dictation://model';

/** The speech model Whisper uses (574 MB, fetched once). */
export interface DictationModelStatus {
  ready: boolean;
  downloading: boolean;
  received: number;
  total: number;
  failed: boolean;
}

export function dictationModelStatus(): Promise<DictationModelStatus> {
  return invoke<DictationModelStatus>('dictation_model_status');
}

export function downloadDictationModel(): Promise<DictationModelStatus> {
  return invoke<DictationModelStatus>('dictation_model_download');
}

export function onDictationModel(
  handler: (status: DictationModelStatus) => void
): Promise<UnlistenFn> {
  return listen<DictationModelStatus>(DICTATION_MODEL_EVENT, (e) => handler(e.payload));
}

/**
 * The conversation's last few messages, newest last, as plain lines for the
 * names pass: who said it and what. Capped; the backend trims it again.
 */
export function dictationContext(lines: { who: string; text: string }[], max = 2_000): string {
  const out: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < 8; i--) {
    const line = `${lines[i].who}: ${lines[i].text.replace(/\s+/g, ' ').trim()}`;
    if (!lines[i].text.trim()) continue;
    if (size + line.length > max) break;
    out.unshift(line);
    size += line.length;
  }
  return out.join('\n');
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
    case 'preparing':
      return {
        message: `Getting dictation ready on ${THIS_COMPUTER}: a one-time 574 MB download.`,
      };
    case 'modelFailed':
      return {
        message:
          'Dictation couldn’t finish getting ready. Check the connection, then try the mic again.',
      };
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
