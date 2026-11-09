/**
 * `--probe`: the states the other phases miss, for `pnpm qa:web --phases probe`.
 *
 * - Fifty agents, one with a very long name and role, one whose chat is a
 *   very long message each way.
 * - A step-in card ("needs you in its browser"): Step in is on the Mac only,
 *   and a plain Allow from the phone is refused with the Mac's words.
 * - A card that the desk answers while it's open on the phone, and an agent
 *   deleted on the desk while its card is open on the phone
 *   (`GET /dev/probe?do=desk-answer` / `do=delete`).
 * - An agent mid-turn; `--restarted` is the same Mac after it restarted:
 *   the turn ended on the Mac's "Interrupted: the app closed…" line.
 * - Quiet hours: the Chief setting them, and a routine that waited for them.
 * - Three Claude accounts: this Mac's, Work out of usage, Personal signed
 *   out; Builder runs only on Work ("Runs on"), and its last turn ran there.
 *
 * Every name, address and number is made up.
 */

import type { Agent, AgentMessage, UsageAccount } from '@shipstudio/companion-protocol';

type Base = (id: string, name: string, role: string, color: string, extra: Partial<Agent>) => Agent;

const MIN = 60_000;
const H = 60 * MIN;

export const PROBE_LONG_NAME =
  'Regional Wholesale Partnerships and Stockist Onboarding Coordinator, Pacific Northwest';

/** The Mac's words for a plain Allow on a step-in card (`agents::step_in::ON_YOUR_MAC`). */
export const STEP_IN_ON_YOUR_MAC = 'Step in on your Mac: press Step in on the card there.';

/** The line a turn the app cut off ends on (`runner::RESTART_LINE`). */
export const RESTART_LINE =
  'Interrupted: the app closed while this agent was working, so the turn stopped part-way. Continue picks it up where it was.';

const COLORS = [
  'blue',
  'green',
  'purple',
  'orange',
  'teal',
  'pink',
  'amber',
  'red',
  'brown',
  'gray',
];
const ROLES = [
  'Supplier follow-ups',
  'Weekly numbers',
  'Social replies',
  'Order checks',
  'Event bookings',
  'Shop copy',
];

const LONG_REPLY = [
  'Here is everything from the supplier thread, in order, so you can decide without opening it.',
  ...Array.from(
    { length: 14 },
    (_, i) =>
      `${i + 1}. On day ${i + 2} they wrote back about the pallet count again; the landed cost per unit moves by about ${(i % 4) + 1}% each time the count changes, and they still haven’t confirmed whether the spring range ships in one container or two.`
  ),
  'Nothing has been sent. Say which quote to accept and I’ll draft the reply for you to check.',
].join('\n\n');

const LONG_ASK = `Can you go through the whole supplier thread ${'and every reply in it '.repeat(12)}and tell me what changed?`;

/** Three Claude accounts and Codex's own, as `agents.accounts` serves them. */
export function probeAccounts(): UsageAccount[] {
  return [
    {
      id: 'default',
      engine: 'claude',
      name: 'sam@example.com',
      named: false,
      thisMac: true,
      signedIn: true,
      email: 'sam@example.com',
      plan: 'Max',
      out: false,
    },
    {
      id: 'w1',
      engine: 'claude',
      name: 'Work',
      named: true,
      thisMac: false,
      signedIn: true,
      email: 'me@work.example',
      plan: 'Max',
      out: true,
      limit: { at: Date.now() - 40 * MIN, resetsAt: Date.now() + 2 * H },
    },
    {
      id: 'p1',
      engine: 'claude',
      name: 'Personal',
      named: true,
      thisMac: false,
      signedIn: false,
      out: false,
    },
    {
      id: 'default',
      engine: 'codex',
      name: 'Signed in on this Mac',
      named: false,
      thisMac: true,
      signedIn: true,
      out: false,
    },
  ];
}

export function addProbeAccount(
  agents: Agent[],
  messages: Map<string, AgentMessage[]>,
  base: Base,
  now: number,
  restarted: boolean
) {
  const put = (agent: Agent, list: Omit<AgentMessage, 'id' | 'agentId'>[]) => {
    agents.push(agent);
    messages.set(
      agent.id,
      list.map((m, i) => ({
        id: `${agent.id}_${String(i).padStart(3, '0')}`,
        agentId: agent.id,
        ...m,
      }))
    );
  };

  // A step-in card: the agent's own browser reached a sign-in only a person can finish.
  put(
    base('browse', 'Browser Helper', 'Bookings on supplier portals', 'teal', {
      pendingApprovals: 1,
      status: { state: 'waiting', activity: null, since: now - 3 * MIN },
      lastActivityAt: now - 3 * MIN,
      preview: 'Needs you in its browser',
    }),
    [
      {
        ts: now - 6 * MIN,
        kind: 'user',
        text: 'Book the kiln delivery slot on the Northwind portal.',
      },
      {
        ts: now - 3 * MIN,
        kind: 'approval',
        text: '',
        approval: {
          requestId: 'req_stepin',
          title: 'Browser Helper needs you in its browser',
          detail: 'The portal asks for a code sent to your phone before it shows the booking page.',
          status: 'pending',
          stepIn: {
            reason:
              'The portal asks for a code sent to your phone before it shows the booking page.',
            site: 'portal.northwind.example',
            url: 'https://portal.northwind.example/login/verify',
            pageTitle: 'Verify it’s you',
            tab: 2,
          },
        },
      },
    ]
  );

  // A card the desk will answer while the phone has it open.
  put(
    base('stale', 'Deploys', 'Ships the shop site', 'blue', {
      pendingApprovals: 1,
      status: { state: 'waiting', activity: null, since: now - 2 * MIN },
      lastActivityAt: now - 2 * MIN,
      preview: 'Needs your OK',
    }),
    [
      { ts: now - 4 * MIN, kind: 'user', text: 'Ship the price fix.' },
      {
        ts: now - 2 * MIN,
        kind: 'approval',
        text: '',
        approval: {
          requestId: 'req_stale',
          title: 'Run a command',
          detail: 'pnpm run deploy --prod',
          summary: 'Run the project’s “deploy” script — to ship the fix to production',
          status: 'pending',
          tool: 'Bash',
        },
      },
    ]
  );

  // An agent the desk will delete while its card is open on the phone.
  put(
    base('doomed', 'Temp Helper', 'One-off clean-up', 'gray', {
      pendingApprovals: 1,
      status: { state: 'waiting', activity: null, since: now - MIN },
      lastActivityAt: now - MIN,
      preview: 'Needs your OK',
    }),
    [
      { ts: now - 3 * MIN, kind: 'user', text: 'Clear out the old exports folder.' },
      {
        ts: now - MIN,
        kind: 'approval',
        text: '',
        approval: {
          requestId: 'req_doomed',
          title: 'Delete files',
          detail: 'rm -r ~/Exports/2024',
          status: 'pending',
          tool: 'Bash',
        },
      },
    ]
  );

  // Mid-turn, on the account it's pinned to; after a restart, cut off.
  put(
    base('builder', 'Builder', 'Builds shop features', 'purple', {
      account: 'w1',
      ranOn: { id: 'w1', name: 'Work' },
      status: restarted
        ? { state: 'idle', activity: null, since: null }
        : { state: 'working', activity: 'Writing the gift-card checkout', since: now - 4 * MIN },
      lastActivityAt: now - 4 * MIN,
      ...(restarted ? { failure: { kind: 'interrupted' as const }, preview: RESTART_LINE } : {}),
    }),
    [
      { ts: now - 5 * MIN, kind: 'user', text: 'Add gift cards to checkout.' },
      {
        ts: now - 4 * MIN,
        kind: 'agent',
        text: 'On it. I’ll add the gift-card field first, then the balance check.',
      },
      ...(restarted
        ? [
            {
              ts: now - MIN,
              kind: 'error' as const,
              text: RESTART_LINE,
              failure: { kind: 'interrupted' as const },
            },
          ]
        : []),
    ]
  );

  // Long both ways.
  put(
    base(
      'long',
      PROBE_LONG_NAME,
      `${PROBE_LONG_NAME}: every stockist, every region, every week`,
      'orange',
      {
        unread: 2,
        lastActivityAt: now - 8 * MIN,
        preview: LONG_REPLY.slice(0, 120),
      }
    ),
    [
      { ts: now - 12 * MIN, kind: 'user', text: LONG_ASK },
      { ts: now - 8 * MIN, kind: 'agent', text: LONG_REPLY },
    ]
  );

  // Quiet hours, in the Chief's chat: set from chat, and a routine that waited.
  const chief = messages.get('chief');
  if (chief) {
    chief.push(
      {
        id: 'chief_quiet_1',
        agentId: 'chief',
        ts: now - 9 * H,
        kind: 'user',
        text: 'Quiet hours 10pm to 7am please, no pings overnight.',
      },
      {
        id: 'chief_quiet_2',
        agentId: 'chief',
        ts: now - 9 * H + 4000,
        kind: 'agent',
        text: 'Quiet hours set: 22:00–07:00 every day, for the whole team. Scheduled work waits until 07:00, and nothing but an approval notifies you until then.',
      },
      {
        id: 'chief_quiet_3',
        agentId: 'chief',
        ts: now - 2 * H,
        kind: 'check_in',
        text: 'Sweep the shop inbox and flag anything urgent',
        checkIn: { dueAt: now - 3 * H, late: true, repeats: true },
      },
      {
        id: 'chief_quiet_4',
        agentId: 'chief',
        ts: now - 2 * H + 6000,
        kind: 'agent',
        text: 'Morning sweep (it waited for quiet hours to end): two orders asking about delivery, nothing urgent.',
      }
    );
  }

  // Up to fifty, the rest plain.
  for (let i = agents.length; i < 50; i++) {
    const id = `p${String(i).padStart(2, '0')}`;
    put(
      base(id, `Helper ${i}`, ROLES[i % ROLES.length], COLORS[i % COLORS.length], {
        lastActivityAt: now - (i + 10) * 7 * MIN,
        unread: i % 5 === 0 ? 1 : 0,
        preview: i % 5 === 0 ? 'Done: the numbers are in the sheet.' : null,
      }),
      [{ ts: now - (i + 10) * 7 * MIN, kind: 'agent', text: 'Done: the numbers are in the sheet.' }]
    );
  }
}
