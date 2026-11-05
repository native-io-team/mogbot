/**
 * "Setting up your team" after an import, as the phone words it: one card in
 * the Chief's chat (desktop `agents/team_setup.rs`, docs/agents.md). The Mac
 * decides what each step holds and whether it's done; this only says it.
 * Plain and short, and never a count that alarms: "A few things to finish",
 * not "41 requests".
 */

import type {
  TeamSetupCheck,
  TeamSetupHello,
  TeamSetupLater,
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
      return step.later?.length
        ? 'Your Mac checked what your team can already reach. Only the rest is here.'
        : 'Each one goes into the Keychain on your Mac, never the chat.';
    case 'routines':
      return 'They arrived paused. Switch on the ones you want; they run while your Mac is awake.';
    case 'missing':
      return `Things your agents said they don’t know yet. ${chief} can sort most of them.`;
    case 'hello':
      return 'Each one starts when you say hi, one at a time.';
  }
}

/** "2 of 4 done", the card's quiet meta. */
export const progress = (v: Pick<TeamSetupView, 'done' | 'total'>) =>
  `${v.done} of ${v.total} done`;

/** The card's source line. */
export const sourceLine = (v: Pick<TeamSetupView, 'source'>) =>
  `A few things to finish setting up your team from ${v.source}`;

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

/* ------------------------------------------- what the team can already reach */

/** "Checking 14 services… Figma ✓ Bankline –", as the Mac's `progress_line` says it. */
export function checkLine(c: TeamSetupCheck): string {
  const n = c.total;
  const s = n === 1 ? '' : 's';
  const head = c.running ? `Checking ${n} service${s}…` : `Checked ${n} service${s}.`;
  const marks = c.checked.map((x) => `${x.title} ${x.reached ? '✓' : '–'}`);
  return marks.length ? `${head} ${marks.join(' ')}` : head;
}

/** Rows nothing on the Mac reached and nobody has decided. */
export const openRows = (rows: TeamSetupLater[] | undefined) =>
  (rows ?? []).filter((r) => r.state === 'open');

/** Rows the check reached, as receipts. */
export const reachedRows = (rows: TeamSetupLater[] | undefined) =>
  (rows ?? []).filter(
    (r): r is TeamSetupLater & { state: 'reachable'; via: string } => r.state === 'reachable'
  );

/** "Figma: your browser, signed in on www.figma.com". */
export const receipt = (r: { title: string; via: string }) => `${r.title}: ${r.via}`;

/** The residue's head line. */
export function residueLine(open: number): string {
  if (open === 0) return 'Your team is ready.';
  return `Your team is ready. ${open} thing${open === 1 ? '' : 's'} I couldn’t reach on this Mac:`;
}

/** "3 reached", the receipts' toggle. */
export const reachedToggle = (n: number) => `${n} reached`;

/** A row's agents line: "Finance, Ops". */
export const rowAgents = (r: Pick<TeamSetupLater, 'agents'>) => r.agents.join(', ');

export const ASKED_LINE = 'Waiting on the sign-in card';
export const NOT_NEEDED = 'Not needed';
export const CHECK_AGAIN = 'Check again';

/** A login card's line for the agents that joined it. */
export const alsoForLine = (names: string[] | undefined) =>
  names && names.length ? `Also for ${names.join(', ')}` : null;

/** Whether the card draws anything (a Mac that has none says `null`). */
export const shows = (v: TeamSetupView | null | undefined): v is TeamSetupView =>
  !!v && !v.dismissed && v.steps.length > 0;
