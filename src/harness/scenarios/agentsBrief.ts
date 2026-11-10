/**
 * The morning brief (`agents/brief.rs`): the Chief's one message at the
 * user's time, composed from the app's records without a turn, and its
 * settings under Notifications.
 *
 * `BRIEF_SAMPLE` is the text `brief::compose` writes for a fictional team
 * (the same shape its Rust tests hold), so what is drawn here is what the
 * Mac posts.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, messagesFor, msg, overview, TEAM } from './agents';

export const BRIEF_SAMPLE = [
  'Morning brief, Monday 9 November: 1 card waits for you, 1 thing didn’t work, 2 routines today, 2 agents worked.',
  '',
  '**Needs you**',
  '- Lead Gen: Send an email',
  '',
  '**Didn’t work**',
  '- Finance’s routine “Sweep the invoices inbox” failed at 3:00 AM: Gmail needs signing in again.',
  '',
  '**Today**',
  '- 9:00 AM Finance: Sweep the invoices inbox',
  '- 2:30 PM Acme Site: Check the staging deploy',
  '',
  '**Since yesterday**',
  '- Acme Site: shared “Pricing table fix”, 3 replies',
  '- Finance: ran 1 routine, 1 reply',
  '',
  '**Usage**',
  '- Room on 2 of 3 accounts (1 not reported), by their own readings.',
  '- Soonest refill: Work (Claude Code), 5-hour limit, at 11:20 AM.',
  '',
  '**Your checks**',
  // A check's words are outside text, escaped (`brief::plain`): they read
  // the same, but nothing in them can become a link or a list.
  '- events on my calendar today (Google Calendar):',
  '  - Standup 9\\:30',
  '  - Acme review call 15\\:00',
  "- unread important mail (Gmail): couldn’t check. Gmail isn't connected\\. Connect it in Apps\\.",
].join('\n');

const BRIEF_SETTINGS = {
  on: true,
  at: 7 * 60 + 30,
  always: false,
  checks: [
    { what: 'events on my calendar today', app: 'Google Calendar' },
    { what: 'unread important mail', app: 'Gmail' },
  ],
  lastPostedAt: Date.now() - 60 * 60 * 1000,
};

const chiefWithBrief = (args: Record<string, unknown>) =>
  args.agentId === 'chief'
    ? [...messagesFor(args), msg('agent', BRIEF_SAMPLE, 2)]
    : messagesFor(args);

export const agentsBriefScenarios: Scenario[] = [
  {
    id: 'agents-morning-brief',
    title: 'Agents — the morning brief in the Chief’s chat',
    looksRightWhen:
      'The Chief of Staff chat ends on one reply, unboxed prose like any other: a first line “Morning brief, Monday 9 November: 1 card waits for you, …” (the notification’s words), then short bold headings in this order: Needs you (the bell’s and the phone tab’s word), Didn’t work, Today, Since yesterday, Usage, Your checks, each with a few plain bullets. Times read 9:00 AM and 2:30 PM, the way the rest of the brief says times. The calendar items are nested bullets; the Gmail line says it couldn’t check and why, in one line. No link, no card chrome, no accent colour.',
    requires: '.agent-chat .agent-bubble--agent',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="chief"]' }],
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: chiefWithBrief,
    },
  },
  {
    id: 'settings-agents-brief',
    title: 'Settings — Morning brief, on at 7:30 AM with two checks',
    looksRightWhen:
      'Opened from ⌘K “Morning brief…”, scrolled to Notifications: under Quiet hours, a “Morning brief” row whose one line says what the Chief posts; on the right a short time field “07:30” and the switch, on. Under it “Post even when there’s nothing new” (off: a day with nothing for you posts nothing) with its switch off, then two rows “Check: events on my calendar today” and “Check: unread important mail”, each saying it is read only and in which app (only the last saying to ask the Chief for more), with a quiet “Remove” text action.',
    command: 'agents.morningBrief',
    requires: '.agents-brief',
    clipSelector: 'section[aria-labelledby="agents-settings-notify"]',
    commands: {
      agents_overview: overview(TEAM),
      agents_morning_brief: BRIEF_SETTINGS,
    },
  },
];
