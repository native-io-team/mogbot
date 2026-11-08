/**
 * "Describe the agent you want" (`agents/draft.rs`) and routines in steps
 * with an OK in the middle (`agents/routine_steps.rs`): the New agent dialog
 * before and after a draft, a routine in steps in the schedule popover and
 * its editor, and the "OK to go on?" card a run waits on. Shapes copied from
 * the Rust serde output, as `fixtures.gen.ts` has them.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, messagesFor, msg, overview, TEAM } from './agents';

const now = Date.now();
const HOUR = 3_600_000;

/** What `agents_draft` returns for the one prompt below. */
const DRAFT = {
  name: 'Weekly Report',
  role: 'Turns my week’s notes into a Friday report for the team.',
  color: 'teal',
  instructions:
    'You write the user’s weekly report every Friday from their notes folder and calendar.\n\n- Lead with what shipped, then what’s blocked and who can unblock it.\n- Keep it under 200 words; link to sources, never paste them.\n- Never post or send anything until the user has OK’d the draft.',
  routines: [
    {
      when: 'every friday at 16:00',
      note: 'Draft this week’s report from the notes folder and my calendar',
      then: [{ text: 'Post it to #team on Slack', askFirst: true }],
      readsAs: 'every friday at 16:00',
    },
    {
      when: 'every monday at 9am',
      note: 'List what slipped last week and ask me what to carry over',
      readsAs: 'every monday at 09:00',
    },
  ],
  apps: ['Slack', 'Google Calendar'],
};

const DESCRIPTION =
  'Every Friday at 4, write my weekly report from my notes and calendar, and post it to #team on Slack once I’ve OK’d it. On Mondays, tell me what slipped.';

/** A routine in steps, its last run waiting on the user's OK. */
const WEEKLY = {
  id: 'ci-weekly',
  note: 'Draft this week’s report from the notes folder and my calendar',
  repeat: { kind: 'days', days: [5], hour: 16, minute: 0 },
  nextAt: now + 3 * 24 * HOUR,
  createdAt: now - 30 * 24 * HOUR,
  paused: false,
  then: [{ text: 'Post it to #team on Slack', askFirst: true }],
  waiting: { runAt: now - HOUR, step: 2, requestId: 'gate-1', askedAt: now - 50 * 60_000 },
  runs: [
    { at: now - 7 * 24 * HOUR, outcome: 'ran', attempt: 1, step: 2 },
    { at: now - HOUR, outcome: 'waiting', attempt: 1, step: 1 },
  ],
};

const REPORT = [
  '**Week of 3 Nov**',
  '',
  '- **Shipped:** the pricing page (Thursday), invoice reminders now go out on day 7',
  '- **Blocked:** the Acme contract, waiting on their legal review (Sam to chase)',
  '- **Next:** onboarding emails, two candidate interviews on Tuesday',
].join('\n');

const gateChat = (status: 'pending' | 'allowed') => (args: Record<string, unknown>) =>
  args.agentId === 'finance'
    ? [
        msg('check_in', WEEKLY.note, 3, {
          agentId: 'finance',
          checkIn: { dueAt: now - HOUR, late: false, repeats: true },
        }),
        msg('agent', REPORT, 2, { agentId: 'finance' }),
        msg('approval', '', 1, {
          agentId: 'finance',
          approval: {
            requestId: 'gate-1',
            title: 'OK to go on?',
            detail: REPORT,
            summary:
              '“Draft this week’s report from the notes folder…” · step 1 of 2 is done. Next, step 2: Post it to #team on Slack',
            status,
            ...(status === 'allowed' ? { choice: 'Going ahead' } : {}),
            gate: {
              checkInId: 'ci-weekly',
              routine: 'Draft this week’s report from the notes folder…',
              done: 1,
              total: 2,
              next: 'Post it to #team on Slack',
              runAt: now - HOUR,
            },
          },
        }),
      ]
    : messagesFor(args);

const withWeekly = overview(
  TEAM.map((a) => (a.id === 'finance' ? { ...a, checkIns: [WEEKLY], pendingApprovals: 1 } : a))
);

const schedulePreview = (args: Record<string, unknown>) => ({
  nextAt: now + 3 * 24 * HOUR,
  repeat: String(args.when).includes('every')
    ? { kind: 'days', days: [5], hour: 16, minute: 0 }
    : null,
});

export const agentsStepsScenarios: Scenario[] = [
  {
    id: 'agents-describe',
    title: 'Agents — New agent opens on “Describe the agent you want”',
    looksRightWhen:
      'The dialog leads with one large field, “Describe the agent you want”, the cursor in it and a specific example as its placeholder; under it a neutral “Draft it” and one muted line saying nothing is made before you check it. “Or start from” and the usual fields follow, quieter.',
    command: 'agents.describe',
    requires: '.agent-describe',
    commands: {},
  },
  {
    id: 'agents-describe-drafted',
    title: 'Agents — a drafted agent, one review before Create',
    looksRightWhen:
      'After Draft it: a muted “Drafted from your description. Check it, then Create.” with Start over; the name “Weekly Report” on a teal badge, its role and briefing filled in and editable; then Routines as one bordered list: “every friday at 16:00” with its two steps numbered, the second “After your OK · Post it to #team on Slack”, and “every monday at 09:00”, both ticked; then one muted line “Uses Slack and Google Calendar. It asks you to connect them…”. No accent but the badge and Create.',
    openSelector: AGENTS_TAB,
    requires: '.agent-draft__routines',
    clipSelector: '.agent-editor',
    steps: [
      { click: '.workspace-sidebar-add-project' },
      { fill: '#agent-describe-text', value: DESCRIPTION },
      { click: '.agent-describe__actions button' },
    ],
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: messagesFor,
      agents_draft: DRAFT,
    },
  },
  {
    id: 'agents-steps-popover',
    title: 'Agents — a routine in steps, its run waiting on your OK',
    looksRightWhen:
      'Finance’s schedule: the routine’s note, “Every Friday at 4:00 PM”, its next time, then its two steps numbered in a muted column, the second “After your OK · Post it to #team on Slack”, and one amber line “Waiting for your OK in the chat”. Past runs · 2.',
    openSelector: AGENTS_TAB,
    requires: '.agent-steps__list',
    clipSelector: '.agent-schedule',
    steps: [{ click: '[data-agent-id="finance"]' }, { click: '.agent-chat__scheduled' }],
    commands: {
      agents_overview: withWeekly,
      agents_messages: gateChat('pending'),
      agents_schedule_preview: schedulePreview,
    },
  },
  {
    id: 'agents-steps-editor',
    title: 'Agents — editing a routine’s steps',
    looksRightWhen:
      'The routine picker with When set to Weekly · Fri at 16:00, What filled, and under it step 2 as a row: a muted “2”, the step’s words, a “Your OK first” checkbox ticked and a quiet ✕; then “Add a step”. The echo says “2 steps · your OK before step 2”.',
    openSelector: AGENTS_TAB,
    requires: '.agent-steps__row',
    clipSelector: '.agent-schedule',
    steps: [
      { click: '[data-agent-id="finance"]' },
      { click: '.agent-chat__scheduled' },
      { click: '[aria-label^="Edit “Draft this week"]' },
    ],
    commands: {
      agents_overview: withWeekly,
      agents_messages: gateChat('pending'),
      agents_schedule_preview: schedulePreview,
    },
  },
  {
    id: 'agents-gate-card',
    title: 'Agents — “OK to go on?” between a routine’s steps',
    looksRightWhen:
      'Under the report Finance drafted, one card “OK to go on?” with the routine and “step 1 of 2 done” as its quiet meta; “Next, step 2 of 2” muted over “Post it to #team on Slack”; then a tinted well “What step 1 made” with the report as prose. A muted note that it waits and closes if the routine runs again. Stop here (outlined) and Go ahead (neutral strong, never the accent); no ⋯.',
    openSelector: AGENTS_TAB,
    requires: '.agent-gate',
    clipSelector: '.agent-approval',
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: withWeekly,
      agents_messages: gateChat('pending'),
    },
  },
  {
    id: 'agents-gate-card-allowed',
    title: 'Agents — “OK to go on?” once answered',
    looksRightWhen:
      'The card folded to one quiet line: “OK to go on? · Going ahead · step 2 of 2 is running”. No buttons.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat__row--card',
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: withWeekly,
      agents_messages: gateChat('allowed'),
    },
  },
];
