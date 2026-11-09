/**
 * Agents on the desktop: the quit guard, quick entry's floating composer, and
 * the settings for the menu-bar icon and the quick-message shortcut.
 *
 * The menu-bar icon and the shortcut itself are native (agents/tray.rs,
 * agents/quick_entry.rs) and can't be drawn here; their logic is unit-tested
 * in Rust. What is here is every piece of React UI they lead to.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, DEFAULTS, ENGINES, msg, now, overview, TEAM } from './agents';
import { FULL_INVENTORY } from './agentsUsage';

/** The composer's window is 600pt wide; the capture gives it a little air. */
const QUICK_ENTRY_VIEWPORT = { width: 600, height: 320 };
const SCREENSHOT = '/harness/agents-demo/attachments/m-att1/Pricing on mobile.jpg';

const DESKTOP_SETTINGS = {
  supported: true,
  menuBarIcon: true,
  quickEntry: true,
  shortcut: 'Alt+Space',
  shortcutLabel: '⌥Space',
};

/** Codex chosen for new agents, on GPT-5.5; Claude Code's on Balanced (Sonnet). */
const CHOSEN = {
  engine: 'codex' as const,
  models: { claude: 'sonnet', codex: 'gpt-5.5' },
  startsOn: 'codex' as const,
  model: 'gpt-5.5',
};

/** `agents_set_defaults`, answered as `agents::defaults::set` would. */
const setDefaults = (args: Record<string, unknown>) => {
  const change = args.change as {
    engine?: 'claude' | 'codex';
    claudeModel?: string;
    codexModel?: string;
  };
  const engine = change.engine ?? CHOSEN.engine;
  const models = {
    claude: change.claudeModel === undefined ? CHOSEN.models.claude : change.claudeModel || null,
    codex: change.codexModel === undefined ? CHOSEN.models.codex : change.codexModel || null,
  };
  return { engine, models, startsOn: engine, model: models[engine] };
};

const quickEntryCommands = {
  agents_overview: overview(),
  quick_entry_hide: null,
  quick_entry_resize: null,
  quick_entry_sent: null,
  quick_entry_open_chat: null,
  quick_entry_capture: SCREENSHOT,
  agents_inspect_files: (args: Record<string, unknown>) =>
    (args.paths as string[]).map((path) => ({
      path,
      name: 'Screenshot 2026-11-04 at 10.42.18.png',
      mime: 'image/jpeg',
      size: 40_266,
    })),
  agents_send: (args: Record<string, unknown>) => ({
    ...msg('user', String(args.text), 0, { agentId: String(args.agentId) }),
    ts: now,
  }),
  start_dictation: null,
  cancel_dictation: null,
  stop_dictation: null,
};

/** Two Claude Code sign-ins (fictional addresses) and Codex signed out. */
const TWO_CLAUDE = [
  {
    id: 'default',
    engine: 'claude',
    name: 'This Mac',
    thisMac: true,
    signedIn: true,
    email: 'sam@example.com',
    plan: 'Max',
    out: false,
  },
  {
    id: 'a1personal',
    engine: 'claude',
    name: 'Personal Account',
    thisMac: false,
    signedIn: true,
    email: 'sam.personal@example.net',
    out: false,
  },
  {
    id: 'default',
    engine: 'codex',
    name: 'This Mac',
    thisMac: true,
    signedIn: false,
    out: false,
  },
];

export const agentsDesktopScenarios: Scenario[] = [
  {
    id: 'agents-quit-guard',
    title: 'Quit — agents still working (⌘Q, menu-bar Quit)',
    looksRightWhen:
      'A small centred alert, not the plain “Are you sure?”: a semibold line “2 agents are still working. Quit anyway?”, then one muted paragraph naming them (“Quitting stops Acme Site and Native App mid-turn…”), saying Lead Gen’s request will still be here when you reopen, and that Keep running in background hides the window instead. Three full-width buttons stacked like a macOS alert: Keep running in background (the accent, focused), Quit (neutral: quitting loses nothing), Cancel (outline).',
    command: 'app.quit',
    requires: '.quit-confirm-modal--guard',
    commands: {
      agents_quit_check: { working: ['Acme Site', 'Native App'], waiting: ['Lead Gen'] },
    },
  },
  {
    id: 'agents-quit-guard-approval',
    title: 'Quit — only an approval waiting: no guard',
    looksRightWhen:
      'An open request is no reason to stay (it is there on reopen), so this is the plain dialog: “Quit now?” in the header, one muted line that agents and routines don’t run while the app is closed, Cancel and a neutral Quit, no agent names.',
    command: 'app.quit',
    requires: '.quit-confirm-plain',
    commands: {
      agents_quit_check: { working: [], waiting: ['Lead Gen'] },
    },
  },
  {
    id: 'agents-quit-guard-scheduled',
    title: 'Quit — a routine due soon',
    looksRightWhen:
      'The guard leads with “Finance has a routine coming up. Quit anyway?”, says routines don’t run while the app is closed and run when you reopen it, and that Lead Gen’s request will still be here. Same three stacked buttons.',
    command: 'app.quit',
    requires: '.quit-confirm-modal--guard',
    commands: {
      agents_quit_check: { working: [], waiting: ['Lead Gen'], scheduled: ['Finance'] },
    },
  },
  {
    id: 'agents-quit-plain',
    title: 'Quit — nothing working',
    looksRightWhen:
      'A standard dialog: the title “Quit <app name>?” in the header, one muted line that agents and routines don’t run while the app is closed, then Cancel and a neutral (not green) Quit right-aligned, Quit focused.',
    command: 'app.quit',
    requires: '.quit-confirm-plain',
    commands: {},
  },
  {
    id: 'agents-quick-entry',
    title: 'Quick entry — just opened (⌥Space)',
    root: 'quick-entry',
    viewport: QUICK_ENTRY_VIEWPORT,
    looksRightWhen:
      'A floating card with a soft shadow on a transparent window: a muted “To” line with the Chief of Staff’s mini badge and name, “@name for another agent”, and a small “esc” keycap at the right. Under it the same composer as a chat — the field (“Message Chief of Staff”), a camera button on the left, mic and send on the right — and one muted line below the card about Screen Recording permission.',
    requires: '.quick-entry__composer',
    commands: quickEntryCommands,
  },
  {
    id: 'agents-quick-entry-mention',
    title: 'Quick entry — @ picks who it goes to',
    root: 'quick-entry',
    viewport: QUICK_ENTRY_VIEWPORT,
    looksRightWhen:
      'Typing “@fi” opens the mention menu under the field, in the card (not floating above the window): Finance first, highlighted. The window grows to fit it.',
    requires: '.quick-entry .agent-mention-menu',
    steps: [{ fill: '.quick-entry__input', value: '@fi' }],
    commands: quickEntryCommands,
  },
  {
    id: 'agents-quick-entry-addressed',
    title: 'Quick entry — addressed to another agent',
    root: 'quick-entry',
    viewport: QUICK_ENTRY_VIEWPORT,
    looksRightWhen:
      'With “@Finance chase Northwind…” typed, the To line shows Finance’s orange badge and name, and the “@name for another agent” hint is gone. Send is green.',
    requires: '.quick-entry__composer',
    steps: [
      {
        fill: '.quick-entry__input',
        value: '@Finance chase Northwind about the $4,200 invoice, politely',
      },
    ],
    commands: quickEntryCommands,
  },
  {
    id: 'agents-quick-entry-screenshot',
    title: 'Quick entry — a screenshot attached',
    root: 'quick-entry',
    viewport: QUICK_ENTRY_VIEWPORT,
    looksRightWhen:
      'After the camera button, the selection comes back as an image chip above the field (the chat composer’s chip, with its remove ×). The permission note is gone: a screenshot has worked.',
    requires: '.quick-entry .agent-attachment-chip',
    steps: [{ click: '.quick-entry__shot' }],
    commands: quickEntryCommands,
  },
  {
    id: 'agents-quick-entry-sent',
    title: 'Quick entry — sent',
    root: 'quick-entry',
    viewport: QUICK_ENTRY_VIEWPORT,
    looksRightWhen:
      'The composer has become one quiet line on the same card: a green tick, “Sent to Chief of Staff”, and a green “Open chat” text action. Nothing else; the window hides itself a moment later.',
    requires: '.quick-entry__sent',
    steps: [
      { fill: '.quick-entry__input', value: 'Book me a table for 4 on Friday, somewhere quiet' },
      { click: '.quick-entry__composer .agent-composer__send' },
    ],
    commands: quickEntryCommands,
  },
  {
    id: 'agents-desktop-settings',
    title: 'Settings — Agents in the menu bar, Quick message',
    looksRightWhen:
      'Settings opens on its Agents tab; under “On this Mac”, two rows in the same style as the others, each with a one-line description: “Agents in the menu bar” (off) and “Quick message” (on), whose line names ⌥Space and @name, with a small field showing ⌥Space under it.',
    command: 'agents.desktopSettings',
    requires: '.agents-desktop-settings .agents-shortcut-field',
    clipSelector: '.agents-desktop-settings',
    commands: {
      agents_desktop_settings: {
        supported: true,
        menuBarIcon: false,
        quickEntry: true,
        shortcut: 'Alt+Space',
        shortcutLabel: '⌥Space',
      },
    },
  },
  {
    id: 'settings-agents',
    title: 'Settings — the Agents tab',
    looksRightWhen:
      'Settings opens on Agents, the first of five tabs (Agents, General, Projects, Appearance, Experimental). Four quiet groups, each a small muted heading: On this Mac (menu bar, quick message, keep awake, keep running when closed, open at login, each with a switch), Engines and models (“New agents start on” with a Claude Code | Codex control, Claude Code pressed, the engines’ states on one line; “Model on Claude Code” and “Model on Codex”, each a menu button showing “Engine’s default”; Routines), Notifications (two plain rows), Away from your desk (Phone and Other assistants, each with Open). Every description is one short sentence; no paragraph anywhere.',
    command: 'agents.desktopSettings',
    requires: '.agents-settings .settings-group__title',
    clipSelector: '.settings-modal',
    commands: {
      agents_overview: overview(),
      agents_desktop_settings: DESKTOP_SETTINGS,
    },
  },
  {
    id: 'settings-agents-user-chrome',
    title: 'Settings — Your Chrome, on, one profile connected',
    looksRightWhen:
      'Opened from ⌘K “Let agents use your Chrome (any engine)…”, scrolled to Your Chrome: a switch, on, with “On. Agents can use your Chrome, in tabs of their own.”; “Chrome can reach this app” — “Done. Chrome can reach this app.”; “Add the extension to Chrome” — “Done. The extension is connected.” with no buttons; then one row “Work” — “Connected (extension 0.1.0).” Nothing in the accent colour.',
    command: 'agents.userChrome',
    requires: '[data-testid="user-chrome-steps"]',
    clipSelector: 'section[aria-labelledby="agents-settings-user-chrome"]',
    commands: {
      agents_overview: overview(TEAM),
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_user_chrome_status: {
        supported: true,
        enabled: true,
        listening: true,
        error: null,
        chromeInstalled: true,
        host: 'current',
        extensionDir: '/Users/you/Library/Application Support/App/chrome-extension',
        extensionVersion: '0.1.0',
        webStoreUrl: null,
        extensionId: 'acpipahophpoekcmokoejnkooedofagk',
        browsers: [
          { profileId: 'p-1', label: 'Work', extensionVersion: '0.1.0', connectedAt: Date.now() },
        ],
        updateNeeded: false,
      },
    },
  },
  {
    id: 'settings-agents-user-chrome-setup',
    title: 'Settings — Your Chrome, on, the extension not added yet',
    looksRightWhen:
      'Your Chrome on with “On. Add the extension to Chrome, then keep Chrome open.”; “Chrome can reach this app” — Done; “Add the extension to Chrome” — “Not done yet. In Chrome’s extensions page turn on Developer mode, press Load unpacked, and choose the folder this shows.” with two neutral buttons, “Open Chrome’s extensions” and “Show the folder”, side by side.',
    command: 'agents.userChrome',
    requires: '[data-testid="user-chrome-steps"]',
    clipSelector: 'section[aria-labelledby="agents-settings-user-chrome"]',
    commands: {
      agents_overview: overview(TEAM),
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_user_chrome_status: {
        supported: true,
        enabled: true,
        listening: true,
        error: null,
        chromeInstalled: true,
        host: 'current',
        extensionDir: '/Users/you/Library/Application Support/App/chrome-extension',
        extensionVersion: '0.1.0',
        webStoreUrl: null,
        extensionId: 'acpipahophpoekcmokoejnkooedofagk',
        browsers: [],
        updateNeeded: false,
      },
    },
  },
  {
    id: 'settings-agents-slack-setup',
    title: 'Settings — Slack, not connected yet',
    looksRightWhen:
      'Opened from ⌘K “Talk to your agents from Slack…”, scrolled to Slack: “Talk to your agents from Slack” with one line saying this Mac reads Slack and nothing runs on a server; then three numbered rows, one short line each: “1. Create the Slack app” with a neutral “Open Slack…” button, “2. Install it” (copy the User OAuth Token, xoxp-…), “3. Paste the token” with a masked field and a neutral, disabled “Connect”. Nothing in the accent colour.',
    command: 'agents.slack',
    requires: '[data-testid="slack-setup"]',
    clipSelector: 'section[aria-labelledby="agents-settings-slack"]',
    commands: {
      agents_overview: overview(TEAM),
      agents_desktop_settings: DESKTOP_SETTINGS,
    },
  },
  {
    id: 'settings-agents-slack',
    title: 'Settings — Slack, connected and listening',
    looksRightWhen:
      'Scrolled to Slack: “Listen in Slack” on, “On in Northwind as robin. Checked just now.”; “Who answers” with a menu button showing the Chief’s name; “Where it listens” — “Your own DM and #launch” with Choose…; “Trigger” with a short field holding “dashbot:”; “Let others start it” off, its line saying their words are outside text and replies always ask; “Replies” saying a reply is posted under your name after you OK the exact words; “Disconnect” with a neutral button. No token anywhere, nothing in the accent colour.',
    command: 'agents.slack',
    requires: '[data-testid="slack-connected"]',
    clipSelector: 'section[aria-labelledby="agents-settings-slack"]',
    commands: {
      agents_overview: overview(TEAM),
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_slack_status: {
        connected: true,
        enabled: true,
        needsSignIn: false,
        team: 'Northwind',
        user: 'robin',
        agentName: 'Chief of Staff',
        conversations: [
          { id: 'D0SELF', kind: 'self', name: 'Your own DM' },
          { id: 'C0LAUNCH', kind: 'channel', name: '#launch' },
        ],
        trigger: 'dashbot:',
        defaultTrigger: 'dashbot:',
        othersCanStart: false,
        lastCheckAt: Date.now(),
        waiting: 0,
        setupUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D',
      },
    },
  },
  {
    id: 'settings-agents-independence',
    title: 'Settings — how independent agents are, set to Bold',
    looksRightWhen:
      'Opened from ⌘K “How independent your agents are…”, scrolled to Independence: the slider “How much it does on its own”, “Asks a lot” left and “Just does it” right, four stops Careful, Steady, Bold, Unleashed with the neutral thumb on Bold (never the accent), Bold’s line “Does local work on this Mac; asks before anything leaves it.”, and under it “Always asks before spending money, using your passwords, or deleting for good.”',
    command: 'agents.independence',
    requires:
      '.agent-independence-settings .independence-slider[data-level="go_hard"] [role="slider"]',
    clipSelector: 'section[aria-labelledby="agents-settings-independence"]',
    commands: {
      agents_overview: { ...overview(TEAM), independence: 'go_hard' },
      agents_desktop_settings: DESKTOP_SETTINGS,
    },
  },
  {
    id: 'settings-agents-admins',
    title: 'Settings — Admins, what they did, and Recently deleted',
    looksRightWhen:
      'Opened from ⌘K “Admins: who manages and approves for your team…”: under Admins, one row per agent with a switch; Chief of Staff on (“Admin: manages and approves local work for the others”), the rest off, and a muted line “Spending, sending, publishing, pushing, sharing and keys always come to you.” Admin activity lists two lines newest first with a time. Recently deleted shows “Kite Watch” deleted by Chief of Staff, “Restorable for 29 more days”, and a Restore button.',
    command: 'agents.admins',
    requires: '.agent-admin-settings .agent-admin-activity__line',
    clipSelector: 'section[aria-labelledby="agents-settings-admins"]',
    commands: {
      agents_overview: overview(TEAM),
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_admin_activity: [
        {
          ts: Date.now() - 5 * 60_000,
          admin: { id: 'chief', name: 'Chief of Staff' },
          target: { id: 'leadgen', name: 'Lead Gen' },
          action: 'Allowed for Lead Gen: look inside your Northwind folder',
        },
        {
          ts: Date.now() - 60 * 60_000,
          admin: { id: 'chief', name: 'Chief of Staff' },
          target: { id: 'kite', name: 'Kite Watch' },
          action: 'Deleted Kite Watch · in Recently deleted for 30 days',
        },
      ],
      agents_recently_deleted: [
        {
          id: 'kite',
          name: 'Kite Watch',
          role: 'Watches the kite shop',
          color: 'teal',
          deletedAt: Date.now() - 60 * 60_000,
          restorableUntil: Date.now() + 29 * 86_400_000 - 60 * 60_000,
          deletedBy: { id: 'chief', name: 'Chief of Staff' },
        },
      ],
    },
  },
  {
    id: 'settings-agents-defaults',
    title: 'Settings — new agents start on Codex, on GPT-5.5',
    looksRightWhen:
      'Opened from ⌘K “Engine and model for new agents…”. Under Engines and models: “New agents start on” with Codex pressed in the Claude Code | Codex control and the line “Claude Code ready · Codex ready”; “Model on Claude Code” shows “Balanced” with a small muted “Sonnet” beside it; “Model on Codex” shows “GPT-5.5”. Both rows say each agent can pick its own in Edit agent. Neutral controls, no accent fill except the pressed segment’s usual treatment; nothing about existing agents changing.',
    command: 'agents.newAgentDefaults',
    requires: '.agent-defaults-settings [data-engine="codex"]',
    clipSelector: 'section[aria-labelledby="agents-settings-engines"]',
    commands: {
      agents_overview: overview(TEAM, true, CHOSEN),
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_set_defaults: setDefaults,
    },
  },
  {
    id: 'settings-agents-defaults-menu',
    title: 'Settings — picking the default model for Claude Code',
    looksRightWhen:
      'The “Model on Claude Code” menu is open under its button: Engine’s default, Most capable (Opus), Balanced (Sonnet, marked as the current choice), Fastest (Haiku), each engine name small and muted at the right. Only Claude Code’s own models; nothing invented. Readable in both themes.',
    // Steps run before a scenario's command, so the palette opens Settings here.
    openSelector: AGENTS_TAB,
    requires: '.agent-defaults-menu',
    steps: [
      { key: 'mod+k' },
      { fill: '.command-palette-input', value: 'Engine and model for new agents' },
      { click: '.command-palette [role="option"]', text: 'Engine and model' },
      { click: '.agent-defaults-settings [data-engine="claude"]' },
    ],
    commands: {
      agents_overview: overview(TEAM, true, CHOSEN),
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_set_defaults: setDefaults,
    },
  },
  {
    id: 'settings-agents-defaults-signed-out',
    title: 'Settings — Codex chosen, but signed out',
    looksRightWhen:
      'Codex was chosen for new agents and has since signed out: in the Claude Code | Codex control Claude Code is pressed and Codex is greyed out (not clickable). The line under “New agents start on” says “Codex isn’t ready, so new agents start on Claude Code for now.” Model rows still show both installed engines; Claude Code’s shows Balanced · Sonnet. Nothing claims Codex is ready.',
    command: 'agents.newAgentDefaults',
    requires: '.agent-defaults-settings [aria-label="New agents start on"] button[disabled]',
    clipSelector: 'section[aria-labelledby="agents-settings-engines"]',
    commands: {
      agents_overview: {
        ...overview(TEAM, true, { ...CHOSEN, startsOn: 'claude', model: 'sonnet' }),
        engines: [ENGINES[0], { ...ENGINES[1], signedIn: false }],
      },
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_set_defaults: setDefaults,
    },
  },
  {
    id: 'settings-agents-defaults-no-models',
    title: 'Settings — Codex lists no models',
    looksRightWhen:
      'Codex is installed and signed in but has not listed its models (no models cache yet): “Model on Codex” has no menu button, just the line “Codex hasn’t listed its models, so new agents use its default.” Claude Code’s row is unchanged with its menu showing “Engine’s default”. No made-up model names anywhere.',
    command: 'agents.newAgentDefaults',
    requires: '.agent-defaults-settings [data-engine="claude"]',
    clipSelector: 'section[aria-labelledby="agents-settings-engines"]',
    commands: {
      agents_overview: {
        ...overview(TEAM, true, DEFAULTS),
        engines: [ENGINES[0], { ...ENGINES[1], models: [] }],
      },
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_set_defaults: setDefaults,
    },
  },
  {
    id: 'agents-new-with-defaults',
    title: 'Agents — a new agent starts on the defaults (Codex, GPT-5.5)',
    looksRightWhen:
      'The New agent dialog with Advanced open: “Runs on” has Codex pressed, and Model has GPT-5.5 chosen — the defaults from Settings → Agents, not Claude Code and Default. Switching it to Claude Code would pick Balanced (Sonnet), Claude Code’s default.',
    steps: [{ click: '.agents-list__new' }, { click: '.agent-editor__more' }],
    requires: '.agent-editor__advanced-body',
    clipSelector: '.agent-editor',
    commands: {
      agents_overview: overview(TEAM, true, CHOSEN),
    },
  },
  {
    id: 'settings-agents-accounts',
    title: 'Settings — Agents → Accounts (usage wallets)',
    looksRightWhen:
      'Under “Accounts”, one muted sentence (“When one runs out of usage, agents carry on with the next, in this order.”), then Claude Code and Codex, each a bordered list of numbered lines. Claude Code: 1 “This Mac” signed in, 2 “Work” in amber “Out of usage until …” with the reset time, then its email, 3 “Personal” “Signed in · me@example.com · last limit …”; Codex: 1 “This Mac”, 2 “ChatGPT Plus” “Not signed in” with Sign in. Each line has a “…” menu (Rename, Sign in again, Remove…) and the up/down pair, the first up and last down disabled; a signed-out line also has one secondary Sign in. Under each list a secondary “Add a … account”, with air before the next engine. Neutral buttons only, no accent.',
    command: 'agents.accounts',
    requires: '.agent-accounts .agent-account',
    clipSelector: '.agent-accounts',
    commands: {
      agents_overview: overview(),
      agents_desktop_settings: {
        supported: true,
        menuBarIcon: true,
        quickEntry: true,
        shortcut: 'Alt+Space',
        shortcutLabel: '⌥Space',
      },
      agents_accounts: [
        {
          id: 'default',
          engine: 'claude',
          name: 'This Mac',
          thisMac: true,
          signedIn: true,
          out: false,
        },
        {
          id: 'a1work',
          engine: 'claude',
          name: 'Work',
          thisMac: false,
          signedIn: true,
          email: 'me@work.example',
          limit: { at: now - 40 * 60_000, resetsAt: now + 3 * 3_600_000 },
          out: true,
        },
        {
          id: 'a2personal',
          engine: 'claude',
          name: 'Personal',
          thisMac: false,
          signedIn: true,
          email: 'me@example.com',
          limit: { at: now - 3 * 86_400_000, resetsAt: now - 2 * 86_400_000 },
          out: false,
        },
        {
          id: 'default',
          engine: 'codex',
          name: 'This Mac',
          thisMac: true,
          signedIn: true,
          out: false,
        },
        {
          id: 'c1plus',
          engine: 'codex',
          name: 'ChatGPT Plus',
          thisMac: false,
          signedIn: false,
          out: false,
        },
      ],
      agents_account_reorder: [],
      agents_account_rename: null,
      agents_account_remove: null,
      agents_account_add: null,
    },
  },
  {
    id: 'settings-agents-accounts-two-claude',
    title: 'Settings — Agents → Accounts: two Claude Code sign-ins, Codex signed out',
    looksRightWhen:
      'Claude Code lists two lines, each with its name in full on the first line and “Signed in · <email>” on the second: 1 “This Mac” with sam@example.com and “Max plan” (read from Claude Code’s own file), and 2 “Personal Account” with sam.personal@example.net. Neither name is cut off; a long email is the thing that truncates. Codex: 1 “This Mac” “Not signed in” with one Sign in button. Row actions are quiet compact buttons on one baseline, the reorder arrows grouped together, Rename, Sign in again and Remove… are in each row’s “…” menu (This Mac’s Remove is greyed, its hover saying why). Each “Add a … account” button has air above the next engine’s heading. Neutral only, no accent.',
    command: 'agents.accounts',
    requires: '.agent-accounts .agent-account',
    clipSelector: '.agent-accounts',
    commands: {
      agents_overview: {
        ...overview(),
        engines: [ENGINES[0], { ...ENGINES[1], signedIn: false }],
      },
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_accounts: TWO_CLAUDE,
      agents_account_reorder: [],
      agents_account_rename: null,
      agents_account_remove: null,
      agents_account_add: null,
    },
  },
  {
    id: 'settings-agents-page',
    title: 'Settings — Agents, the whole tab',
    looksRightWhen:
      'Every group of Settings → Agents in one tall shot: On this Mac, Engines and models, Usage, Accounts, Notifications, Away from your desk. Each group has the same small muted heading, the same air above and below, and one full-width divider under it that never touches the last control. Rows line up on one left edge; every description is one muted line. Both themes readable; nothing accent-coloured except chosen state.',
    command: 'agents.accounts',
    requires: '.agent-accounts .agent-account',
    clipSelector: '.agents-settings',
    viewport: { width: 1280, height: 3000 },
    commands: {
      agents_overview: {
        ...overview(),
        engines: [ENGINES[0], { ...ENGINES[1], signedIn: false }],
      },
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_usage_overview: FULL_INVENTORY,
      agents_accounts: TWO_CLAUDE,
      agents_account_reorder: [],
      agents_account_rename: null,
      agents_account_remove: null,
      agents_account_add: null,
    },
  },
];
