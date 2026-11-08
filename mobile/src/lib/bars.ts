/**
 * What the bars above a chat's composer say (`components/surfaces.tsx`):
 * the state of this conversation until it ends, each in one place, never
 * also in the header. Pure, so the order and the words are tested.
 */

import {
  revisingLabel,
  type Agent,
  type AgentMessage,
  type ResultRef,
} from '@shipstudio/companion-protocol';

/**
 * The fixed order, top to bottom. The demo above everything: a sample chat
 * must never be read as a real one. Then the link: while the Mac is out of
 * reach everything under it is the saved copy, and that is the one thing to
 * know before reading the rest. Then the Mac being driven, an import, the
 * message being written, and what the engine can't do.
 */
export const BAR_ORDER = [
  'demo',
  'connection',
  'driven',
  'import',
  'setup',
  'revising',
  'engine',
] as const;
export type BarId = (typeof BAR_ORDER)[number];

/** How many bars show before the rest fold into "N more". */
export const MAX_BARS = 2;

/**
 * amber = waiting on you, running blue = going on, muted = information, red =
 * a problem. Status roles only: the agent's accent is never a status.
 */
export type BarTone = 'waiting' | 'active' | 'info' | 'problem';

export interface BarText {
  tone: BarTone;
  title: string;
  detail?: string;
  /** Going on now: the bar leads with the typing dots. */
  live?: boolean;
}

/** Driven by hand on the Mac (desktop Take over): the row's words, and the bar's. */
export const drivenLine = (name: string) => `You’re driving ${name} on your Mac`;

/** What a message sent while it's driven does: the desk's words. */
export const drivenWait = (name: string) => `sends when you hand ${name} back`;

export function drivenBar(agent: Agent): BarText | null {
  if (!agent.takeover) return null;
  return {
    tone: 'active',
    title: drivenLine(agent.name),
    detail: `Hand it back there. What you send here waits until then.`,
  };
}

const IMPORTING = /^Bringing in agents from (.+)$/;

/**
 * The Chief's status while an import interview runs (`connector::
 * interview_status`). The import bar says it then, so the working row keeps
 * only its dots (`lib/timeline.ts`), as on the desk.
 */
export const isImportInterview = (activity: string | null | undefined) =>
  IMPORTING.test(activity ?? '');

/**
 * An import another assistant started (desktop `agents/connector.rs`), from
 * what this phone knows: a pending consent or review request in the chat, or
 * the Chief's own status while the interview runs. Says the state, never the
 * request's question, and never points at "the card".
 */
export function importBar(
  agent: Agent,
  messages: AgentMessage[] | undefined,
  reviewHere = false
): BarText | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const approval = messages![i].approval;
    const connector = approval?.connector;
    if (!connector || approval.status !== 'pending') continue;
    if (connector.kind === 'consent')
      return {
        tone: 'waiting',
        title: `Import from ${connector.source} · Needs your OK`,
        detail: 'Nothing has been shared yet.',
      };
    if (connector.kind === 'playback')
      return {
        tone: 'waiting',
        title: `Import from ${connector.source} · check the plan`,
        detail: 'Is anything missing? Nothing is created until you import.',
      };
    // The review card above says what happens; the bar only says the state.
    return reviewHere
      ? { tone: 'waiting', title: `Import from ${connector.source} · ready to review` }
      : { tone: 'waiting', title: `Import from ${connector.source} · waiting on your Mac` };
  }
  const going = agent.status.state !== 'idle' && IMPORTING.exec(agent.status.activity ?? '');
  if (!going) return null;
  // One line, as on the desk. That the interview is a separate conversation
  // which can't see your chats is said once, by the note in the chat.
  return { tone: 'active', title: `Importing from ${going[1]}`, live: true };
}

/** The message being written asks to change a result: "Changes to Brief (v2)". */
export function revisingBar(revising: ResultRef | undefined): BarText | null {
  return revising ? { tone: 'info', title: revisingLabel(revising) } : null;
}
