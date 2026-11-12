/**
 * Settings' pages: the section list down the left of the Settings window, in
 * order, and how every way in (⌘K, a chat note's button, the Chief's
 * `open_settings`, an old tab request) lands on one of them.
 *
 * The ids are also the Chief's (`settings_tools::SETTINGS_PAGES` in Rust):
 * change one in both places.
 *
 * @module lib/settingsPages
 */

import type { SettingsSectionRequest, SettingsTabRequest } from './settings';
import { relayOn } from './brand';
import { THIS_COMPUTER } from './computer';

export type SettingsPage =
  | 'account'
  | 'agents'
  | 'independence'
  | 'accounts'
  | 'phone'
  | 'notifications'
  | 'chrome'
  | 'apps'
  | 'projects'
  | 'appearance'
  | 'advanced';

export interface SettingsPageInfo {
  id: SettingsPage;
  title: string;
  /** One line under the page's title. */
  lead: string;
  /** Extra words ⌘K matches the page on. */
  keywords: string[];
  /** Only in a build with our hosted relay (`relayOn()`): elsewhere it isn't listed. */
  relayOnly?: true;
}

/** In the order the section list shows them: agents' pages, then the app's. */
export const SETTINGS_PAGES: readonly SettingsPageInfo[] = [
  {
    id: 'account',
    title: 'Account',
    lead: 'Signing in, and what it lets your phone do.',
    keywords: ['sign in', 'sign out', 'log in', 'log out', 'google', 'email', 'relay'],
    relayOnly: true,
  },
  {
    id: 'agents',
    title: 'Agents',
    lead: `What new agents run on, ${THIS_COMPUTER}, disk space, and bringing agents in.`,
    keywords: [
      'engine',
      'model',
      'new agents start on',
      'claude code',
      'codex',
      'opencode',
      'menu bar',
      'quick message',
      'shortcut',
      `keep ${THIS_COMPUTER.toLowerCase()} awake`,
      'keep awake',
      'keep running when closed',
      'open at login',
      'fix stopped previews',
      'slow down on battery',
      'disk space',
      'import',
    ],
  },
  {
    id: 'independence',
    title: 'Independence',
    lead: 'How much your agents do on their own, and what they can reach.',
    keywords: [
      'autonomy',
      'permissions',
      'careful',
      'steady',
      'bold',
      'unleashed',
      'what agents can reach',
      'rules',
      'admins',
      'admin activity',
      'recently deleted',
    ],
  },
  {
    id: 'accounts',
    title: 'Accounts & usage',
    lead: 'The accounts your agents run on, and how they use their limits.',
    keywords: [
      'usage',
      'limits',
      'accounts',
      'add an account',
      'subscription',
      'plan',
      'refill',
      'reset',
      'save my limits',
      'use it all',
      'when every account is out',
      'ideas for leftover usage',
    ],
  },
  {
    id: 'phone',
    title: 'Phone',
    lead: 'Your agents away from your desk: the phone app and other assistants.',
    keywords: [
      'mobile',
      'iphone',
      'android',
      'pair',
      'tailscale',
      'away',
      'remote access',
      'other assistants',
      'chatgpt',
      'grok',
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    lead: 'Quiet hours, the morning brief, and what notifies you.',
    keywords: [
      'quiet hours',
      'do not disturb',
      'morning brief',
      'replies',
      'requests',
      'sound',
      'dock badge',
      'mute',
    ],
  },
  {
    id: 'chrome',
    title: 'Chrome',
    lead: 'The agents’ own browser, and your Chrome when you let them use it.',
    keywords: ['browser', 'agents’ browser', 'your chrome', 'extension', 'signed in', 'google'],
  },
  {
    id: 'apps',
    title: 'Apps',
    lead: 'Slack, and apps you said no to.',
    keywords: ['slack', 'connections', 'declined', 'said no', 'integrations'],
  },
  {
    id: 'projects',
    title: 'Projects',
    lead: 'Where projects live, what goes into their commits, and their previews and terminals.',
    keywords: [
      'projects folder',
      'shared libraries',
      'commits',
      'commit message',
      'credit',
      'made-with',
      'dev servers',
      'thumbnails',
      'terminal',
      'gpu',
    ],
  },
  {
    id: 'appearance',
    title: 'Appearance',
    lead: 'Theme, accent color, and how the project workspace looks.',
    keywords: [
      'theme',
      'dark',
      'light',
      'accent',
      'color',
      'colour',
      'community banner',
      'compact toolbar',
      'element breadcrumb',
    ],
  },
  {
    id: 'advanced',
    title: 'Advanced',
    lead: 'Usage reports, and extras that stay off until you turn them on.',
    keywords: ['analytics', 'experimental', 'spotify', 'error reports'],
  },
];

export const DEFAULT_SETTINGS_PAGE: SettingsPage = 'agents';

/** The pages this build lists: Account only with the relay. */
export function visibleSettingsPages(relay = relayOn()): readonly SettingsPageInfo[] {
  return SETTINGS_PAGES.filter((p) => relay || !p.relayOnly);
}

export function settingsPageInfo(page: SettingsPage): SettingsPageInfo {
  return (
    visibleSettingsPages().find((p) => p.id === page) ??
    SETTINGS_PAGES.find((p) => p.id === DEFAULT_SETTINGS_PAGE)!
  );
}

export function isSettingsPage(value: unknown): value is SettingsPage {
  return typeof value === 'string' && visibleSettingsPages().some((p) => p.id === value);
}

/** The page each part of Settings that a command can scroll to lives on. */
export const SECTION_PAGE: Record<SettingsSectionRequest, SettingsPage> = {
  'agent-defaults': 'agents',
  'agent-disk': 'agents',
  'agent-low-power': 'agents',
  'agent-usage': 'accounts',
  'agent-independence': 'independence',
  'agent-policy': 'independence',
  'agent-on-its-own': 'independence',
  'agent-admins': 'independence',
  'agent-user-chrome': 'chrome',
  'agent-slack': 'apps',
  'agent-quiet': 'notifications',
  'agent-brief': 'notifications',
};

/** An older tab request's page: General and Experimental became Advanced. */
export function pageForTab(tab: SettingsTabRequest): SettingsPage {
  if (tab === 'general' || tab === 'experimental') return 'advanced';
  return tab;
}

/**
 * Where Settings opens: a part asked for wins (it is the more exact), then
 * the accounts area asked for, then a page or tab, then Agents.
 */
export function openingPage(asked: {
  section?: SettingsSectionRequest | null;
  accounts?: boolean;
  tab?: SettingsTabRequest | null;
}): SettingsPage {
  if (asked.section) return SECTION_PAGE[asked.section];
  if (asked.accounts) return 'accounts';
  // "agents" is what every agent setting used to ask for alongside its part;
  // alone it is still the Agents page.
  if (asked.tab) {
    const page = pageForTab(asked.tab);
    // Account in a build with no relay: there is no such page here.
    return visibleSettingsPages().some((p) => p.id === page) ? page : DEFAULT_SETTINGS_PAGE;
  }
  return DEFAULT_SETTINGS_PAGE;
}
