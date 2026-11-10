/**
 * Settings the Chief changes from chat, and the desk following them.
 *
 * - **Quiet hours** (`agents::quiet`): read and set here too (Settings →
 *   Agents → Notifications), worded by the protocol's `quiet.ts`, the same
 *   on the phone. The chat's `set_quiet_hours` emits {@link QUIET_EVENT}.
 * - **Morning brief** (`agents::brief`): on or off, its time, quiet days
 *   and the user's checks, worded by the protocol's `brief.ts`. The chat's
 *   `set_morning_brief` emits {@link BRIEF_EVENT}.
 * - **The app's own switches** (Slow down on battery, `power.rs`; new
 *   agents' engine and model; the menu bar and quick message; Projects',
 *   Appearance's and Advanced's switches): the Chief's `change_app_setting`
 *   writes them with the same commands Settings uses and emits
 *   {@link APP_SETTINGS_EVENT} with what changed. Settings reads its rows
 *   again, and {@link followAppSettings} hands each window the event its
 *   readers already listen for.
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
import type { BriefCheck, MorningBrief } from '../../packages/companion-protocol/src/brief';
import type { AgentEngine } from './agents';
import {
  COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT,
  ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT,
  SPOTIFY_WIDGET_ENABLED_CHANGED_EVENT,
} from './settings';

export {
  QUIET_DETAIL,
  QUIET_TITLE,
  clockLabel,
  parseClock,
  quietLabel,
  validQuietWindow,
  type QuietWindow,
} from '../../packages/companion-protocol/src/quiet';

export {
  BRIEF_ALWAYS,
  BRIEF_DETAIL,
  BRIEF_TITLE,
  type BriefCheck,
  type MorningBrief,
} from '../../packages/companion-protocol/src/brief';

export const QUIET_EVENT = 'agents-quiet-hours-changed';
export const BRIEF_EVENT = 'agents-morning-brief-changed';
export const APP_SETTINGS_EVENT = 'app-settings-changed';
export const OPEN_SETTINGS_EVENT = 'agents-open-settings';

export const getQuietHours = () => invoke<QuietWindow | null>('agents_quiet_hours');
export const setQuietHours = (window: QuietWindow | null) =>
  invoke<QuietWindow | null>('agents_set_quiet_hours', { window });

export const setMorningBrief = (
  brief: Pick<MorningBrief, 'on' | 'at' | 'always'>,
  checks?: BriefCheck[]
) =>
  invoke<MorningBrief>('agents_set_morning_brief', {
    on: brief.on,
    at: brief.at,
    always: brief.always,
    checks: checks ?? null,
  });

/**
 * What `change_app_setting` changed, by its key (`settings_tools::SWITCHES`):
 * `{ compact_toolbar: true }`. Empty for the theme or battery alone.
 */
export type AppSettingsChanged = Record<string, boolean>;

/** The window event each switch's readers already listen for, by key. */
const FOLLOWED_BY: Record<string, string> = {
  compact_toolbar: COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT,
  element_breadcrumb: ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT,
  spotify_controls: SPOTIFY_WIDGET_ENABLED_CHANGED_EVENT,
};

/**
 * Pass a change made from chat on to this window, as Settings' own switch
 * would have: the workspace toolbar, the preview's breadcrumb and the
 * Spotify controls follow at once. Exported for tests.
 */
export function followAppSettings(changed: AppSettingsChanged | null | undefined) {
  for (const [key, on] of Object.entries(changed ?? {})) {
    const name = FOLLOWED_BY[key];
    if (name && typeof on === 'boolean') {
      window.dispatchEvent(new CustomEvent<boolean>(name, { detail: on }));
    }
  }
}

export const onAppSettingsChanged = (
  fn: (changed: AppSettingsChanged) => void
): Promise<UnlistenFn> =>
  listen<AppSettingsChanged | null>(APP_SETTINGS_EVENT, (e) => fn(e.payload ?? {}));

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
