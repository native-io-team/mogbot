/**
 * "Setting up your team" after an import, as the phone words it: one card in
 * the Chief's chat (desktop `agents/team_setup.rs`, docs/agents.md). The Mac
 * decides what each step holds and whether it's done; this only says it.
 * Plain and short, and never a count that alarms: "2 steps left",
 * not "41 requests".
 */

import type {
  AgentMessage,
  TeamSetupHello,
  TeamSetupLogin,
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

/** The bar above the Chief's composer while some is left: the desk's words. */
export const SETUP_BAR_TITLE = 'A few things to finish setting up your team';

/**
 * Where the card was posted, as a time: what the Mac says, else (an older
 * Mac) the import's end — its review card and the line after it. `null`
 * when neither is known.
 */
export function setupAnchor(
  view: Pick<TeamSetupView, 'postedAt'>,
  messages: readonly AgentMessage[]
): number | null {
  if (view.postedAt) return view.postedAt;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].approval?.connector?.kind !== 'review') continue;
    let ts = messages[i].ts;
    for (let j = i + 1; j < messages.length && messages[j].kind === 'note'; j++)
      ts = messages[j].ts;
    return ts;
  }
  return null;
}

/** The bar while some is left ("2 of 4 done"); none once it's done or put away. */
export function setupBar(
  v: TeamSetupView | null | undefined
): { tone: 'waiting'; title: string; detail: string } | null {
  if (!shows(v) || v.complete) return null;
  return { tone: 'waiting', title: SETUP_BAR_TITLE, detail: progress(v) };
}

/** Whether the card draws anything (a Mac that has none says `null`). */
export const shows = (v: TeamSetupView | null | undefined): v is TeamSetupView =>
  !!v && !v.dismissed && v.steps.length > 0;

/** A key as words: "email_drafts" → "Email drafts" (as the Mac's `team_setup::humanise`). */
export function humanise(key: string): string {
  const words = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'A login';
}

/** A login's row title: never the raw key. */
export const loginTitle = (l: TeamSetupLogin) => l.title ?? humanise(l.name);

/**
 * Logins by service, whoever needs them, headed by the app's name, never a
 * key ("Google — Gmail (2 accounts)", "GitHub (2 accounts)", "Email drafts").
 * The desk's `groupLogins`, the same rows.
 */
export function groupLogins(
  logins: TeamSetupLogin[]
): { key: string; name: string; items: TeamSetupLogin[] }[] {
  const groups = new Map<string, { key: string; family?: string; items: TeamSetupLogin[] }>();
  for (const l of logins) {
    const key = (l.group ?? loginTitle(l)).trim().toLowerCase();
    const g = groups.get(key) ?? { key, family: l.family, items: [] };
    g.items.push(l);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const byTitle = new Map<string, Set<string>>();
    for (const l of g.items) {
      const t = loginTitle(l);
      const accounts = byTitle.get(t) ?? new Set<string>();
      accounts.add((l.account ?? l.name).trim().toLowerCase());
      byTitle.set(t, accounts);
    }
    const joined = [...byTitle]
      .map(([t, a]) => (a.size > 1 ? `${t} (${a.size} accounts)` : t))
      .join(', ');
    const name = g.family && joined !== g.family ? `${g.family} — ${joined}` : joined;
    return { key: g.key, name, items: g.items };
  });
}
