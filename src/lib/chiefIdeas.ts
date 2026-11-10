/**
 * What to ask the Chief of Staff first: the chips under its greeting and the
 * "More ideas…" gallery behind them. One catalogue, so a chip and its row in
 * the gallery always type the same words.
 *
 * Who it's for: people who already run an assistant and want work that keeps
 * going without them. So every idea is a pipeline, not a one-off: something
 * starts it (a time, a file, an email), agents hand the work between them,
 * and it ends on a card the user answers, on the desk or the phone.
 *
 * An idea may need something this Mac doesn't have yet (GitHub, an email
 * app, a folder, the repo as a project). That is never a dead end: the
 * Chief's first step is to set it up with the user, conversationally
 * (`CHIEF_INSTRUCTIONS`, `src-tauri/src/agents/prompts.rs`), and the
 * gallery line says so up front.
 *
 * None sends by itself: each `text` is a complete brief with one blank at
 * its end, typed into the composer for the user to finish, and nothing goes
 * until they press Send.
 *
 * @module lib/chiefIdeas
 */

export type ChiefIdeaGroup = 'schedule' | 'trigger' | 'together';

export interface ChiefIdea {
  id: string;
  /** The chip and the gallery row's title: a plain starter, no "…" (it types the brief, it doesn't send). */
  label: string;
  /** One line in the gallery: what happens, and what it needs, said honestly. */
  what: string;
  /** Typed into the Chief's composer: a whole brief whose one blank ends it. */
  text: string;
  group: ChiefIdeaGroup;
}

export const GROUP_LABEL: Record<ChiefIdeaGroup, string> = {
  schedule: 'On a schedule',
  trigger: 'When something happens',
  together: 'Agents together',
};

export const CHIEF_IDEAS: readonly ChiefIdea[] = [
  {
    id: 'morning-brief',
    label: 'Brief me every morning',
    what: 'Every weekday at 8am a researcher reads what’s new on the topics you pick and a writer boils it down to one short brief. The first one comes right away, so you see it today.',
    text: 'Every weekday at 8am, have a researcher read what’s new on the topics I care about and a writer turn it into one short brief: the three things worth knowing and why they matter to me. Do the first one now so I can see it. My topics: ',
    group: 'schedule',
  },
  {
    id: 'ship-fixes',
    label: 'Ship fixes while I sleep',
    what: 'Each night a fixer takes your top open GitHub issue and fixes it in its own copy, a reviewer checks it, and the morning brings one card: Keep, Review or Discard. Your Chief helps you connect GitHub first.',
    text: 'Every night at 1am, have one agent take the top open GitHub issue in my repo and fix it in its own copy of the project, then have a second agent review the fix. In the morning, give me one card with the change to keep, review or discard. Nothing gets pushed without me. The repo: ',
    group: 'schedule',
  },
  {
    id: 'competitors',
    label: 'Watch my competitors',
    what: 'Every Monday a researcher reads their sites and changelogs, an analyst compares them with last week, and you get one brief: what changed and what to do about it.',
    text: 'Every Monday at 8am, have a researcher read these competitors’ sites and changelogs and an analyst compare them with last week’s notes, then send me one brief: what changed, and what I should do about it. The competitors: ',
    group: 'schedule',
  },
  {
    id: 'invoices',
    label: 'Chase unpaid invoices',
    what: 'Every Monday an agent finds what’s overdue and another drafts a polite reminder for each. You get one card with the list and the drafts, and nothing is sent without your Allow. Your Chief helps you connect where your invoices live first.',
    text: 'Every Monday at 9am, have one agent check which of my invoices are overdue and another draft a polite reminder for each, then send me one card with the list and the drafts. Nothing is sent without my Allow. My invoices are in: ',
    group: 'schedule',
  },
  {
    id: 'errors',
    label: 'Babysit my errors',
    what: 'Every hour an agent checks a project for new errors, reproduces what broke and fixes it in its own copy, for you to keep or discard. When nothing broke, it says so in a line.',
    text: 'Every hour, check this project for new errors (its dev server, its logs, or an error feed I name), reproduce anything new, fix it in a copy and send me a card to keep or discard. If nothing broke, just say so in one line. The project: ',
    group: 'schedule',
  },
  {
    id: 'client-brief',
    label: 'Turn client briefs into sites',
    what: 'When a brief lands in a folder you pick, an agent reads it, starts a project, drafts the site and sends you a card with Preview. Nothing goes to the client.',
    text: 'When a new client brief lands in a folder, read it, start a new project for it, draft the site and send me a card I can preview. Nothing goes to the client without me. The folder to watch: ',
    group: 'trigger',
  },
  {
    id: 'inbox',
    label: 'Sort my inbox, draft replies',
    what: 'One agent sorts new email, another drafts the replies worth sending, and nothing is sent without your Allow. Your Chief helps you connect your email first.',
    text: 'Set up an inbox crew: through the day, one agent sorts my new email into needs me, can wait and ignore, and another drafts replies to the ones that need me. Nothing is sent without my Allow. My email is in: ',
    group: 'trigger',
  },
  {
    id: 'launch',
    label: 'Run my launch as a team',
    what: 'A strategist, a writer and a builder in a room with your Chief, so you talk to the whole team at once, a standup from them every weekday at 9am, and your Chief keeping the plan.',
    text: 'Run my launch as a team: create a strategist, a writer and a builder, put them and yourself in a room so I can talk to everyone at once, keep the plan yourself in a file, and every weekday at 9am collect a standup from each of them and send me one summary with what’s blocked and what needs me. The launch: ',
    group: 'together',
  },
  {
    id: 'research',
    label: 'Research it and write it up',
    what: 'A researcher gathers sources and a writer turns them into a clear draft with every source linked. Each week it looks for anything new and tells you what changed.',
    text: 'Have a researcher dig into this and collect good sources, and a writer turn them into a clear draft with every source linked. Then every week, look for new sources, update the draft and tell me what changed. The topic: ',
    group: 'together',
  },
  {
    id: 'debate',
    label: 'Have two agents argue it out',
    what: 'Two new agents take opposite sides, each answers the other’s case, and your Chief brings you the verdict.',
    text: 'Create two agents, a Skeptic and a Champion, have them argue this out, each answering the other’s case, and bring me your verdict: ',
    group: 'together',
  },
];

/**
 * The chips under the greeting: three that show work running without the
 * user (every morning, on a trigger, a team), one from each group, and that
 * someone who isn't a developer recognises as theirs. The morning brief and
 * the launch need nothing set up, so a first result can land in the first
 * minutes; the GitHub and folder ideas are a click away in the gallery,
 * where they don't make the first screen read as a coding tool. A fixed order: rotating them would make the
 * first screen differ between two people comparing notes, and between a
 * screenshot and the app.
 */
export const CHIEF_CHIP_IDS = ['morning-brief', 'inbox', 'launch'] as const;

export function findIdea(id: string): ChiefIdea | null {
  return CHIEF_IDEAS.find((idea) => idea.id === id) ?? null;
}

export const CHIEF_CHIPS: readonly ChiefIdea[] = CHIEF_CHIP_IDS.map((id) => findIdea(id)!);

/** The gallery's groups, in order, each with its ideas. */
export function ideaGroups(): { group: ChiefIdeaGroup; label: string; ideas: ChiefIdea[] }[] {
  return (Object.keys(GROUP_LABEL) as ChiefIdeaGroup[]).map((group) => ({
    group,
    label: GROUP_LABEL[group],
    ideas: CHIEF_IDEAS.filter((idea) => idea.group === group),
  }));
}
