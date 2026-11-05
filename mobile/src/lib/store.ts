/**
 * The app's one store: the synced state (sync.ts) plus what the phone knows
 * about the link itself. Screens read slices with selectors, so a streaming
 * draft re-renders the bubble that shows it and nothing else.
 */

import type {
  LinkState,
  PushStatus,
  RefusedFrame,
  TeamSetupView,
  WelcomeFrame,
} from '@shipstudio/companion-protocol';
import { create } from 'zustand';
import type { ComposerDraft } from './drafts';
import type { Credentials } from './pairing';
import { emptySync, type SyncState } from './sync';
import type { TextSize } from './theme';

export interface AppState extends SyncState {
  /** Read from the keychain at launch; `undefined` until then. */
  credentials: Credentials | null | undefined;
  link: LinkState;
  welcome: WelcomeFrame | null;
  /**
   * What this Mac last said it serves (its welcome's methods and features),
   * kept in the offline copy. Only for drawing: an offline card keeps the
   * answers the Mac offers, disabled, instead of changing shape. Never for
   * deciding whether to call something; `welcome` is the live answer.
   */
  served: Served | null;
  refusal: RefusedFrame | null;
  /** NetInfo's view of this phone: null until it has answered. */
  phoneOnline: boolean | null;
  /** The chat on screen (with the app in the foreground), for focus and alerts. */
  openChat: string | null;
  /** What's typed in each chat's composer and not sent: kept across screens and launches. */
  composer: Record<string, ComposerDraft>;
  prefs: Prefs;
  /** iOS Increase Contrast / Android high-contrast text. */
  highContrast: boolean;
  /** Push, as the Mac last answered `devices.setPush`; null until it has. */
  push: PushStatus | null;
  /** "Setting up your team", as the Mac last answered it; null when there's none. */
  teamSetup: TeamSetupView | null;
}

export interface Served {
  methods: string[];
  features: string[];
}

/** Light or dark: the system's (the default), or one this phone keeps whatever the system does. */
export type AppearancePref = 'system' | 'light' | 'dark';

export interface Prefs {
  haptics: boolean;
  appearance: AppearancePref;
  /** Settings → Text size, on top of Dynamic Type (`TEXT_SIZES` in theme.ts). */
  textSize: TextSize;
}

export const defaultPrefs: Prefs = { haptics: true, appearance: 'system', textSize: 'default' };

export const useApp = create<AppState>(() => ({
  ...emptySync(),
  credentials: undefined,
  link: { kind: 'connecting', attempt: 0 },
  welcome: null,
  served: null,
  refusal: null,
  phoneOnline: null,
  openChat: null,
  composer: {},
  prefs: defaultPrefs,
  highContrast: false,
  push: null,
  teamSetup: null,
}));

export const setApp = useApp.setState;
export const getApp = useApp.getState;

/** Apply a pure sync transition to the store. */
export function update(fn: (s: SyncState) => SyncState) {
  useApp.setState((s) => fn(s));
}

/**
 * Whether the Mac serves `method` (and, when given, `feature`), for drawing
 * a card: live when connected, the Mac's last answer while it's away.
 */
export const useServed = (method: string, feature?: string) =>
  useApp((s) => {
    const served = s.welcome
      ? { methods: s.welcome.methods as string[], features: s.welcome.features ?? [] }
      : s.served;
    return !!served?.methods.includes(method) && (!feature || served.features.includes(feature));
  });
