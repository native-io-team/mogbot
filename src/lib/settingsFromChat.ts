/**
 * Settings the Chief changes from chat, and the desk following them.
 *
 * - **Quiet hours** (`agents::quiet`): read and set here too (Settings →
 *   Agents → Notifications), worded by the protocol's `quiet.ts`, the same
 *   on the phone. The chat's `set_quiet_hours` emits {@link QUIET_EVENT}.
 * - **Slow down on battery** (`power.rs`): on by default; the Chief's
 *   `change_app_setting` emits {@link APP_SETTINGS_EVENT}.
 * - **Opening Settings** for what needs the user's own hands on the Mac: a
 *   Slack token pasted into a masked field, an engine account's browser
 *   sign-in. The Chief's `slack_settings connect` and `manage_account add`
 *   emit {@link OPEN_SETTINGS_EVENT}; nothing secret ever passes through chat.
 *   Its `open_settings` emits the same event to open one page
 *   ("Open Settings → Phone").
 *
 * @module lib/settingsFromChat
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { QuietWindow } from '../../packages/companion-protocol/src/quiet';
import type { AgentEngine } from './agents';

export {
  QUIET_DETAIL,
  QUIET_TITLE,
  clockLabel,
  parseClock,
  quietLabel,
  validQuietWindow,
  type QuietWindow,
} from '../../packages/companion-protocol/src/quiet';

export const QUIET_EVENT = 'agents-quiet-hours-changed';
export const APP_SETTINGS_EVENT = 'app-settings-changed';
export const OPEN_SETTINGS_EVENT = 'agents-open-settings';

export const getQuietHours = () => invoke<QuietWindow | null>('agents_quiet_hours');
export const setQuietHours = (window: QuietWindow | null) =>
  invoke<QuietWindow | null>('agents_set_quiet_hours', { window });

export const getLowPower = () => invoke<boolean>('get_low_power_on_battery');
export const setLowPower = (enabled: boolean) =>
  invoke<void>('set_low_power_on_battery', { enabled });

/** What the Chief asked the desk to open (`settings_tools::EVENT_OPEN_SETTINGS`). */
export type OpenSettingsRequest =
  | { section: 'slack' }
  | { section: 'accounts'; engine?: AgentEngine; accountId?: string }
  /** The Chief's `open_settings`: one page, opened to look at; nothing changes. */
  | { section: 'page'; page: string };

export const onOpenSettings = (fn: (request: OpenSettingsRequest) => void): Promise<UnlistenFn> =>
  listen<OpenSettingsRequest>(OPEN_SETTINGS_EVENT, (e) => fn(e.payload));

/* An account whose sign-in the Chief started, for Settings → Accounts. */
let pendingSignIn: string | null = null;
const signInListeners = new Set<(id: string) => void>();

/** Ask Accounts to run this account's sign-in: now if it's on screen, else when it mounts. */
export function requestAccountSignIn(id: string) {
  if (signInListeners.size > 0) signInListeners.forEach((fn) => fn(id));
  else pendingSignIn = id;
}

export function takeAccountSignIn(): string | null {
  const id = pendingSignIn;
  pendingSignIn = null;
  return id;
}

export function onAccountSignIn(fn: (id: string) => void): () => void {
  signInListeners.add(fn);
  return () => signInListeners.delete(fn);
}
