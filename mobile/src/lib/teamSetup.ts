/**
 * "Setting up your team" after an import, as the phone words it: one card in
 * the Chief's chat (desktop `agents/team_setup.rs`, docs/agents.md). The Mac
 * decides what each step holds and whether it's done; this only says it.
 * Plain and short, and never a count that alarms: "2 steps left",
 * not "41 requests".
 */

import type {
  TeamSetupHello,
  TeamSetupStep,
  TeamSetupStepId,
  TeamSetupView,
} from '@shipstudio/companion-protocol';

export const SETUP_TITLE = 'Setting up your team';

const TITLES: Record<TeamSetupStepId, string> = {
  logins: 'Add logins',
  routines: 'Switch on routines',
  missing: 'What they’re missing',
  hello: 'Say hi to your team',
};

export const stepTitle = (id: TeamSetupStepId) => TITLES[id];

/** The line under an open step's title: what it is, and that it's in hand. */
export function stepHint(step: TeamSetupStep, chief: string): string {
  switch (step.id) {
    case 'logins':
      return 'Each one goes into the Keychain on your Mac, never the chat.';
    case 'routines':
      return 'They arrived paused. Switch on the ones you want; they run while your Mac is awake.';
    case 'missing':
      return `Things your agents said they don’t know yet. ${chief} can sort most of them.`;
    case 'hello':
      return 'Each one starts when you say hi, one at a time.';
  }
}

/** "2 steps left", the card's quiet meta: what's left, never requests. */
export const progress = (v: Pick<TeamSetupView, 'done' | 'total'>) => {
  const left = Math.max(0, v.total - v.done);
  if (left === 0) return 'All done';
  return `${left} ${left === 1 ? 'step' : 'steps'} left`;
};

/** The card's source line. */
export const sourceLine = (v: Pick<TeamSetupView, 'source' | 'agents'>) =>
  `${v.agents > 1 ? `Your ${v.agents} agents` : 'Your agent'} from ${v.source} ${
    v.agents > 1 ? 'are' : 'is'
  } here, quiet until you say hi. These get them going.`;

/** Set aside on the update: said once, quietly, never as a number. */
export const SET_ASIDE_NOTE =
  'Some earlier requests were set aside. Nothing they asked for ran; an agent asks again if it still needs to.';

export const COMPLETE_LINE = 'Your team is set up.';

/** The step the card opens on: the first open one. */
export const openStep = (v: TeamSetupView): TeamSetupStepId | null =>
  v.current ?? v.steps.find((s) => s.state === 'open')?.id ?? null;

/** Someone is replying to a hello: the other Say hi buttons wait. */
export const anyReplying = (agents: TeamSetupHello[] | undefined) =>
  !!agents?.some((a) => a.state === 'working');

/** A hello row's state, in words. */
export function helloWord(a: TeamSetupHello): string | null {
  if (a.state === 'working') return 'Replying…';
  if (a.state === 'said_hi') return 'Said hi';
  return null;
}

/** A done or skipped step's word, beside its title. */
export function stateWord(step: TeamSetupStep): string | null {
  if (step.state === 'done') return 'Done';
  if (step.state === 'skipped') return 'Skipped';
  return null;
}

/** Whether the card draws anything (a Mac that has none says `null`). */
export const shows = (v: TeamSetupView | null | undefined): v is TeamSetupView =>
  !!v && !v.dismissed && v.steps.length > 0;
