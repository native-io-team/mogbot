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

export type SettingsPage =
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
}

/** In the order the section list shows them: agents' pages, then the app's. */
export const SETTINGS_PAGES: readonly SettingsPageInfo[] = [
  {
    id: 'agents',
    title: 'Agents',
    lead: 'This Mac, the engine and model new agents start on, and disk space.',
    keywords: ['engine', 'model', 'keep awake', 'login', 'disk', 'menu bar', 'import'],
  },
  {
    id: 'independence',
    title: 'Independence',
    lead: 'How much your agents do on their own, and what they can reach.',
    keywords: ['autonomy', 'permissions', 'careful', 'steady', 'bold', 'unleashed', 'admins'],
  },
  {
    id: 'accounts',
    title: 'Accounts & usage',
    lead: 'The accounts your agents run on, and how they use their limits.',
    keywords: ['usage', 'limits', 'accounts', 'subscription', 'plan', 'reset'],
  },
  {
    id: 'phone',
    title: 'Phone',
    lead: 'Your agents away from your desk: the phone app and other assistants.',
    keywords: ['mobile', 'iphone', 'away', 'remote', 'assistants', 'chatgpt', 'grok'],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    lead: 'What notifies you, and when to keep quiet.',
    keywords: ['quiet hours', 'mute', 'sound', 'badge', 'do not disturb'],
  },
  {
    id: 'chrome',
    title: 'Chrome',
    lead: 'The agents’ own browser, and your Chrome when you let them use it.',
    keywords: ['browser', 'extension', 'signed in', 'google'],
  },
  {
    id: 'apps',
    title: 'Apps',
    lead: 'Slack, and apps you said no to.',
    keywords: ['slack', 'connections', 'declined', 'integrations'],
  },
  {
    id: 'projects',
    title: 'Projects',
    lead: 'Where projects live, and what the app does in them.',
    keywords: ['folder', 'commits', 'thumbnails', 'terminal', 'libraries'],
  },
  {
    id: 'appearance',
    title: 'Appearance',
    lead: 'Theme, accent and the workspace’s layout.',
    keywords: ['theme', 'dark', 'light', 'accent', 'color', 'toolbar'],
  },
  {
    id: 'advanced',
    title: 'Advanced',
    lead: 'Usage reports, and things that are off by default.',
    keywords: ['analytics', 'experimental', 'spotify', 'dev servers'],
  },
];

export const DEFAULT_SETTINGS_PAGE: SettingsPage = 'agents';

export function settingsPageInfo(page: SettingsPage): SettingsPageInfo {
  return SETTINGS_PAGES.find((p) => p.id === page) ?? SETTINGS_PAGES[0];
}

export function isSettingsPage(value: unknown): value is SettingsPage {
  return typeof value === 'string' && SETTINGS_PAGES.some((p) => p.id === value);
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
  if (asked.tab) return pageForTab(asked.tab);
  return DEFAULT_SETTINGS_PAGE;
}
