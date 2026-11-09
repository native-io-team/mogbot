/**
 * Edge states the other agents scenarios walk past: names and roles at their
 * longest, fifty agents, an agent with nothing said yet, the quiet lines the
 * Mac writes into a chat (a turn that ended without a reply, helpers left
 * running, an account switch, disk low, a routine late for quiet hours), the
 * independence slider at every stop and from the keyboard, Your Chrome in
 * each of its states, a draft that fails, and an "OK to go on?" answered No
 * or overtaken by the routine running again.
 *
 * Every line here is a string the Mac writes (`agents/turn_end.rs`,
 * `agents/wallet.rs`, `agents/disk.rs`) or a shape copied from the `invoke`
 * types at the call sites; every name is fictional.
 */

import type { Scenario } from '../types';
import { rejectsWith } from '../reject';
import { AGENTS_TAB, MIN, TEAM, agent, messagesFor, msg, now, overview, status } from './agents';

/* ------------------------------------------------------------ long names */

/** At the editor's own 40-character limit, and a single word that can't wrap. */
const LONG_NAME = 'Quarterly Investor Relations Coordinator';
const UNBROKEN = 'Superextraordinarilylongunbrokenagentname';
const LONG_ROLE =
  'Prepares the quarterly investor update from the metrics dashboard, chases every department head for their numbers, drafts the letter in my voice and books the follow-up calls with each investor who replies with questions.';

const LONG_TEAM = [
  ...TEAM,
  agent('longname', LONG_NAME, {
    color: 'amber',
    shape: 4,
    minutesAgo: 1,
    role: LONG_ROLE,
    preview:
      'I have the numbers from Finance and Sales; Engineering’s headcount is still missing, so I asked Priya for it and will finish the draft as soon as she answers.',
    status: status(
      'working',
      'Reading the metrics dashboard export for every month of the quarter, then comparing it against the board deck'
    ),
    unread: 12,
    pendingApprovals: 3,
    pinned: true,
  }),
  agent('unbroken', UNBROKEN, {
    color: 'pink',
    shape: 7,
    minutesAgo: 3,
    role: 'Abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnop',
    preview: 'https://example.com/a/really/long/path/without/any/spaces/at/all/that/goes/on',
  }),
];

const LONG_CHAT = (args: Record<string, unknown>) =>
  args.agentId === 'longname'
    ? [
        msg('user', 'Start on this quarter’s investor update.', 30, { agentId: 'longname' }),
        msg('agent', 'On it. I’ll ask each department for its numbers first.', 29, {
          agentId: 'longname',
        }),
      ]
    : messagesFor(args);

/* --------------------------------------------------------------- 50 agents */

const COLORS = ['purple', 'teal', 'blue', 'orange', 'green', 'pink', 'amber', 'red', 'brown'];
const FIFTY = [
  TEAM[0],
  ...Array.from({ length: 49 }, (_, i) =>
    agent(`a${i + 1}`, `Agent ${String(i + 1).padStart(2, '0')}`, {
      color: COLORS[i % COLORS.length],
      shape: i % 12,
      minutesAgo: 5 + i * 37,
      role: i % 4 === 0 ? 'Watches one inbox and drafts replies' : '',
      preview: i % 3 === 0 ? 'Done: the summary is in your Downloads folder.' : null,
      unread: i % 7 === 0 ? 2 : 0,
      pendingApprovals: i % 11 === 0 ? 1 : 0,
      status: i % 9 === 0 ? status('working', 'Reading the latest messages') : status('idle'),
    })
  ),
];

/* ------------------------------------------------------ the Mac's own lines */

/** One agent whose chat carries every quiet line the Mac writes. */
const OPS = agent('ops', 'Operations', {
  color: 'blue',
  shape: 3,
  minutesAgo: 0,
  role: 'Keeps the shared drive and the vendor list tidy',
  status: status('working', 'Waiting for the 3 helpers it started to report back'),
});

const OPS_CHAT = [
  msg('check_in', 'Tidy the vendor list and flag anything unpaid', 300, {
    agentId: 'ops',
    checkIn: { dueAt: now - 420 * MIN, late: true, repeats: true },
  }),
  msg('note', 'Switched to Work: This Mac is out of usage until 10:00 AM.', 290, {
    agentId: 'ops',
  }),
  msg('agent', 'The vendor list is tidy; two invoices are unpaid and I’ve flagged them.', 280, {
    agentId: 'ops',
  }),
  msg('user', 'Check the shared drive for duplicates too.', 60, { agentId: 'ops' }),
  msg(
    'note',
    'Finished without a reply. What it did is in its timeline; ask it what it found.',
    55,
    { agentId: 'ops' }
  ),
  msg('user', 'What did you find?', 20, { agentId: 'ops' }),
  msg(
    'note',
    'Finished without a reply. The 2 helpers it started in the background stopped with it, before reporting back. Ask it to run them again.',
    18,
    { agentId: 'ops' }
  ),
  msg('note', 'Switched to Personal.', 6, { agentId: 'ops' }),
  msg('user', 'Run them again, one folder each.', 5, { agentId: 'ops' }),
];

const DISK_LINE = msg(
  'note',
  'This Mac is nearly out of disk space: 3.2 GB free. Agents now ask before installing packages or cloning. Settings → Agents shows the largest agent folders, with Free up space.',
  2
);

/** `agents/chrome_health.rs`: Claude in Chrome answered no browser, Your Chrome isn't set up. */
const CHROME_DOWN_LINE = msg(
  'note',
  'Chrome isn’t reachable through Claude’s extension. Set up Your Chrome once (Settings → Agents → Your Chrome) so this can’t happen again. Until then, agents use their own browser for sites signed in there.',
  1,
  { fix: 'user_chrome' }
);

const chromeDownChat = (args: Record<string, unknown>) =>
  args.agentId === 'chief'
    ? [...(messagesFor(args) as unknown[]), CHROME_DOWN_LINE]
    : messagesFor(args);

const linesChat = (args: Record<string, unknown>) => {
  if (args.agentId === 'ops') return OPS_CHAT;
  if (args.agentId === 'chief') return [...(messagesFor(args) as unknown[]), DISK_LINE];
  return messagesFor(args);
};

/* ------------------------------------------------------------- Your Chrome */

const chrome = (over: Record<string, unknown>) => ({
  supported: true,
  enabled: true,
  listening: true,
  error: null,
  chromeInstalled: true,
  host: 'current',
  extensionDir: '/Users/you/Library/Application Support/App/chrome-extension',
  extensionVersion: '0.2.0',
  webStoreUrl: null,
  extensionId: 'acpipahophpoekcmokoejnkooedofagk',
  browsers: [],
  updateNeeded: false,
  ...over,
});

const chromeAt = (
  id: string,
  title: string,
  looksRightWhen: string,
  status: unknown
): Scenario => ({
  id,
  title: `Settings — Your Chrome, ${title}`,
  looksRightWhen,
  command: 'agents.userChrome',
  requires: 'section[aria-labelledby="agents-settings-user-chrome"]',
  clipSelector: 'section[aria-labelledby="agents-settings-user-chrome"]',
  commands: { agents_overview: overview(TEAM), agents_user_chrome_status: status },
});

/* ------------------------------------------------------------- independence */

const LEVELS = [
  ['often', 'Careful'],
  ['judgement', 'Steady'],
  ['go_hard', 'Bold'],
  ['full_send', 'Unleashed'],
] as const;

const independenceAt = ([level, label]: (typeof LEVELS)[number]): Scenario => ({
  id: `settings-agents-independence-${level.replace('_', '-')}`,
  title: `Settings — independence at ${label}`,
  looksRightWhen: `The thumb on ${label}, the fill reaching it and no further, ${label} the only stop name in the strong colour, its own one line under the track; the end stops' names sit inside the slider's edges, not cut off.`,
  command: 'agents.independence',
  requires: `.agent-independence-settings .independence-slider[data-level="${level}"]`,
  clipSelector: 'section[aria-labelledby="agents-settings-independence"]',
  commands: { agents_overview: { ...overview(TEAM), independence: level } },
});

/** Pressing → once from Steady: the backend answers, and the overview follows. */
let keyboardLevel = 'judgement';
const keyboardCommands = {
  agents_overview: () => ({ ...overview(TEAM), independence: keyboardLevel }),
  agents_set_independence: (args: Record<string, unknown>) => {
    keyboardLevel = String(args.level);
    return keyboardLevel;
  },
};

/* ----------------------------------------------------------- the gate card */

const gateChat = (status: 'denied' | 'expired', choice?: string) => () => [
  msg('agent', '**Week of 3 Nov**\n\n- Shipped the pricing page', 4, { agentId: 'finance' }),
  msg('approval', '', 3, {
    agentId: 'finance',
    approval: {
      requestId: 'gate-2',
      title: 'OK to go on?',
      detail: '**Week of 3 Nov**\n\n- Shipped the pricing page',
      summary: 'step 1 of 2 is done. Next, step 2: Post it to #team on Slack',
      status,
      ...(choice ? { choice } : {}),
      gate: {
        checkInId: 'ci-weekly',
        routine: 'Draft this week’s report from the notes folder…',
        done: 1,
        total: 2,
        next: 'Post it to #team on Slack',
        runAt: now - 60 * MIN,
      },
    },
  }),
];

export const agentsProbeScenarios: Scenario[] = [
  {
    id: 'agents-probe-long-names',
    title: 'Agents — a 40-character name, an unbroken name and a very long role',
    looksRightWhen:
      'Sidebar: both long rows keep to one line each, ellipsised, their dots and counts unclipped and the row height unchanged; the unbroken name never pushes the sidebar wider. The open chat’s header shows the 40-character name whole or ellipsised, never under the trailing actions, and the role clipped to one line.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="longname"]' }],
    requires: '.agent-chat__header',
    commands: { agents_overview: overview(LONG_TEAM), agents_messages: LONG_CHAT },
  },
  {
    id: 'agents-probe-unbroken-name',
    title: 'Agents — the unbroken name in the header, narrow window',
    looksRightWhen:
      'At 900px the unbroken 41-letter name ellipsises in the header rather than overflowing it; the trailing actions keep their size.',
    viewport: { width: 900, height: 800 },
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="unbroken"]' }],
    requires: '.agent-chat__header',
    commands: { agents_overview: overview(LONG_TEAM), agents_messages: LONG_CHAT },
  },
  {
    id: 'agents-probe-fifty',
    title: 'Agents — fifty agents',
    looksRightWhen:
      'The sidebar scrolls; every row the same height; working rows show their line; counts never wrap. Nothing below the list (rooms, the usage line) is pushed out of reach.',
    openSelector: AGENTS_TAB,
    requires: '[data-agent-id="a49"]',
    commands: { agents_overview: overview(FIFTY), agents_messages: messagesFor },
  },
  {
    id: 'agents-probe-fifty-team',
    title: 'Agents — fifty agents in What’s in flight',
    looksRightWhen:
      'What’s in flight lists those needing you, then the working ones; one row each, nothing overflowing.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '.agents-list__needs-you' }],
    requires: '.agents-team',
    commands: { agents_overview: overview(FIFTY), agents_messages: messagesFor },
  },
  {
    id: 'agents-probe-no-messages',
    title: 'Agents — an agent nobody has talked to yet',
    looksRightWhen:
      'Agent 07’s chat: no lines, an empty-state invitation and the composer; no “Loading…” left behind, no error.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="a7"]' }],
    requires: '.agent-chat__header',
    commands: { agents_overview: overview(FIFTY), agents_messages: [] },
  },
  {
    id: 'agents-probe-mac-lines',
    title: 'Agents — the quiet lines the Mac writes into a chat',
    looksRightWhen:
      'Operations’ chat: a routine line “late, was due …”; “Switched to Work: This Mac is out of usage until 10:00 AM.” and “Switched to Personal.” as quiet lines; two “Finished without a reply…” lines, the second naming the 2 helpers that stopped, each whole and wrapping inside the column. The working line reads “Waiting for the 3 helpers it started to report back”.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="ops"]' }],
    requires: '.agent-chat__header',
    commands: { agents_overview: overview([...TEAM, OPS]), agents_messages: linesChat },
  },
  {
    id: 'agents-probe-disk-line',
    title: 'Agents — the disk-low line in the Chief’s chat',
    looksRightWhen:
      'The Chief’s chat ends on one quiet line, “This Mac is nearly out of disk space: 3.2 GB free…”, wrapping inside the column, not a card and not red.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="chief"]' }],
    requires: '.agent-chat__header',
    commands: { agents_overview: overview([...TEAM, OPS]), agents_messages: linesChat },
  },
  {
    id: 'agents-probe-chrome-down-line',
    title: 'Agents — Chrome isn’t reachable through Claude’s extension',
    looksRightWhen:
      'The Chief’s chat ends on one quiet line, “Chrome isn’t reachable through Claude’s extension. Set up Your Chrome once (Settings → Agents → Your Chrome) so this can’t happen again. Until then, agents use their own browser…”, then “· Set up Your Chrome” as a link-style button; wrapping inside the column, not a card, not red, nothing about signing in to the Claude extension.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="chief"]' }],
    requires: '[data-fix="user_chrome"]',
    commands: { agents_overview: overview(TEAM), agents_messages: chromeDownChat },
  },
  {
    id: 'agents-probe-chrome-down-fix',
    title: 'Agents — “Set up Your Chrome” opens its settings',
    looksRightWhen:
      'Pressing “Set up Your Chrome” on the line opens Settings on Agents, scrolled to Your Chrome: the switch, off, with its one line.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="chief"]' }, { click: '[data-fix="user_chrome"] button' }],
    requires: 'section[aria-labelledby="agents-settings-user-chrome"]',
    clipSelector: 'section[aria-labelledby="agents-settings-user-chrome"]',
    commands: { agents_overview: overview(TEAM), agents_messages: chromeDownChat },
  },
  ...LEVELS.map(independenceAt),
  {
    id: 'settings-agents-independence-keyboard',
    title: 'Settings — independence moved one stop with the keyboard',
    looksRightWhen:
      'Focused and moved with → from Steady: the thumb on Bold, Bold’s line under it, a neutral focus ring around the slider; no error toast.',
    command: 'agents.independence',
    requires: '.agent-independence-settings .independence-slider[data-level="go_hard"]',
    clipSelector: 'section[aria-labelledby="agents-settings-independence"]',
    afterCommand: [
      { focus: '.agent-independence-settings [role="slider"]' },
      { key: 'ArrowRight' },
    ],
    commands: keyboardCommands,
  },
  chromeAt(
    'settings-agents-user-chrome-off',
    'off',
    'Off: the switch off and one line saying what it does; no steps under it.',
    chrome({ enabled: false, listening: false, host: 'missing', extensionDir: null })
  ),
  chromeAt(
    'settings-agents-user-chrome-no-chrome',
    'on, Chrome not installed and the host not set up',
    '“Google Chrome — Not done yet. Install Google Chrome on this Mac first.”, then “Chrome can reach this app — Not done yet. Turn Your Chrome off and on to set it up.”, then the extension row with its buttons.',
    chrome({ chromeInstalled: false, host: 'missing' })
  ),
  chromeAt(
    'settings-agents-user-chrome-error',
    'on, but it couldn’t start',
    'The line under the switch reads “On, but it couldn’t start: …” ending in one full stop, never two; the stale-host row says the app moved.',
    chrome({ listening: false, error: 'The socket folder is not writable.', host: 'stale' })
  ),
  chromeAt(
    'settings-agents-user-chrome-update',
    'two profiles, one on an old extension',
    '“On. Agents can use 2 of your Chrome profiles…”; two rows, “Work” and “Chrome profile 2”, each saying the app ships a newer extension, wrapping rather than cut off.',
    chrome({
      updateNeeded: true,
      browsers: [
        { profileId: 'p-1', label: 'Work', extensionVersion: '0.1.0', connectedAt: now },
        { profileId: 'p-2', label: '', extensionVersion: '0.1.0', connectedAt: now },
      ],
    })
  ),
  chromeAt(
    'settings-agents-user-chrome-store',
    'on, with a Web Store listing',
    'The extension row says to add it from the Chrome Web Store and offers one button, “Add to Chrome…”.',
    chrome({ webStoreUrl: 'https://chromewebstore.google.com/detail/x' })
  ),
  {
    id: 'agents-probe-describe-error',
    title: 'Agents — describing an agent, the draft fails',
    looksRightWhen:
      'The description stays in the field and is editable again; Draft it is enabled; one error line under it in the error colour with its icon, saying what went wrong.',
    openSelector: AGENTS_TAB,
    requires: '.agent-describe .agent-editor__error',
    clipSelector: '.agent-editor',
    steps: [
      { click: '.workspace-sidebar-add-project' },
      {
        fill: '#agent-describe-text',
        value: 'Every morning, read my inbox and tell me the three things that matter.',
      },
      { click: '.agent-describe__actions button' },
    ],
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: messagesFor,
      agents_draft: rejectsWith(
        'Claude Code is signed out, so it couldn’t draft this. Sign in again from Settings → Agents.'
      ),
    },
  },
  {
    id: 'agents-probe-describe-problem',
    title: 'Agents — a drafted routine the app couldn’t read',
    looksRightWhen:
      'Two routines: the readable one ticked; the other unticked, its checkbox disabled, and the reason in muted text under it.',
    openSelector: AGENTS_TAB,
    requires: '.agent-draft__problem',
    clipSelector: '.agent-editor',
    steps: [
      { click: '.workspace-sidebar-add-project' },
      { fill: '#agent-describe-text', value: 'Remind me to water the plants whenever it’s dry.' },
      { click: '.agent-describe__actions button' },
    ],
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: messagesFor,
      agents_draft: {
        name: 'Garden',
        role: 'Keeps the plants alive.',
        color: 'green',
        instructions: 'Remind the user to water the plants.',
        routines: [
          { when: 'every day at 8am', note: 'Check the forecast', readsAs: 'every day at 08:00' },
          {
            when: 'whenever it is dry',
            note: 'Remind me to water the plants',
            problem: 'Give it a day and a time.',
          },
        ],
        apps: [],
      },
    },
  },
  {
    id: 'agents-gate-card-denied',
    title: 'Agents — “OK to go on?” answered Stop here',
    looksRightWhen: 'The card folded to one quiet line with “Stopped here”; no buttons.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat__row--card',
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: gateChat('denied', 'Stopped here'),
    },
  },
  {
    id: 'agents-gate-card-expired',
    title: 'Agents — “OK to go on?” closed by the routine running again',
    looksRightWhen: 'The card folded to one quiet line saying it closed; no buttons, nothing red.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat__row--card',
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: { agents_overview: overview(TEAM), agents_messages: gateChat('expired') },
  },
];
