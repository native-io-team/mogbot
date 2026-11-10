/**
 * The Settings window: a section list on the left, one page at a time on the
 * right (`dashboard/SettingsModal.tsx`, `lib/settingsPages.ts`). One scenario
 * per page, opened the way a user would from ⌘K ("Settings → Phone"), plus
 * the list driven from the keyboard. Capture with `--theme light` and
 * `--theme dark` for both themes.
 */

import type { Scenario } from '../types';
import { DEFAULTS, ENGINES, overview, TEAM } from './agents';
import { SETTINGS_PAGES, type SettingsPage } from '../../lib/settingsPages';

/** A laptop's window: the sheet fills it with a margin, the page scrolls inside. */
const VIEWPORT = { width: 1280, height: 860 };

const WHAT_EACH_SHOWS: Record<SettingsPage, string> = {
  agents:
    'On this Mac (menu bar, quick message, keep awake, keep running when closed, open at login, stopped previews, battery), What agents run on, Disk space when it shows, and Bring agents in with Import….',
  independence:
    'Your team: one line, then the four-stop slider (no title of its own, the page says Independence) on Steady with a neutral thumb, its line and the always-asks line. Then What agents can reach: the lead, the team’s lines with no Independence line, the enforced note, and no presets anywhere. Then Each agent’s independence with no level box (the slider above is it), then Admins.',
  accounts:
    'The usage and accounts groups exactly as they are elsewhere: this page only places them.',
  phone:
    'Your phone: the phone panel itself (get the app, or turn on phone access, pair and the paired phones) right on the page; then Other assistants: Remote access’s own setup or live view. No Open buttons and no dialog on top.',
  notifications: 'From your agents: Replies and requests, Quiet hours, and Mute an agent.',
  chrome: 'The agents’ own browser, then Your Chrome with its switch.',
  apps: 'Slack, then apps you said no to when there are any.',
  projects:
    'Projects folder with its path field, Shared libraries with Manage, thumbnails, the commit-message and credit switches, terminal GPU.',
  appearance: 'Theme, accent colour, then the compact toolbar and breadcrumb switches.',
  advanced: 'Usage analytics & error reports, then Keep dev servers running and Spotify controls.',
};

const pageScenario = (page: (typeof SETTINGS_PAGES)[number]): Scenario => ({
  id: `settings-page-${page.id}`,
  title: `Settings — ${page.title}`,
  looksRightWhen: `A sheet filling the window with a margin. Down the left, a recessed list: Agents, Independence, Accounts & usage, Phone, Notifications, Chrome, Apps, a hairline, then Projects, Appearance, Advanced; “${page.title}” held with the neutral pressed surface (never the accent). On the right, “${page.title}” as the page title, one muted lead line (“${page.lead}”), then: ${WHAT_EACH_SHOWS[page.id]} The page column stops at a readable width; nothing runs under the list; only the page scrolls.`,
  command: `settings.page.${page.id}`,
  requires: `[data-settings-page="${page.id}"] .settings-window__page-title`,
  clipSelector: '.settings-window',
  viewport: VIEWPORT,
  commands: {
    agents_overview: { ...overview(TEAM), engines: ENGINES, defaults: DEFAULTS },
  },
});

export const settingsWindowScenarios: Scenario[] = [
  ...SETTINGS_PAGES.map(pageScenario),
  {
    id: 'settings-page-keyboard',
    title: 'Settings — moving down the section list with the keyboard',
    looksRightWhen:
      'Opened on Agents, then ↓ twice from the list: Accounts & usage is the page shown, held in the list and focused (a neutral ring), with its title on the right.',
    command: 'settings.page.agents',
    requires: '[data-settings-page="accounts"] .settings-window__page-title',
    clipSelector: '.settings-window',
    viewport: VIEWPORT,
    afterCommand: [
      { focus: '[data-settings-nav="agents"]' },
      { key: 'ArrowDown' },
      { key: 'ArrowDown' },
    ],
    commands: {
      agents_overview: { ...overview(TEAM), engines: ENGINES, defaults: DEFAULTS },
    },
  },
  {
    id: 'settings-page-narrow',
    title: 'Settings — a narrow window',
    looksRightWhen:
      'At 640 wide the list runs across the top as one row that scrolls sideways, with Independence held; the page fills the width under it. No text clipped, nothing overlapping.',
    command: 'settings.page.independence',
    requires: '[data-settings-page="independence"] .settings-window__page-title',
    clipSelector: '.settings-window',
    viewport: { width: 640, height: 820 },
    commands: {
      agents_overview: { ...overview(TEAM), engines: ENGINES, defaults: DEFAULTS },
    },
  },
];
