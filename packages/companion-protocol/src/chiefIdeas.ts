/**
 * What to ask the Chief of Staff first: the chips under its greeting and the
 * "More ideas…" gallery behind them. One catalogue, so a chip and its row in
 * the gallery always type the same words.
 *
 * Who it's for: anyone with jobs that keep coming back (an inbox, invoices,
 * a job search, a trip), most of whom have never written code. So every
 * idea is an everyday job run as a pipeline, not a one-off: something
 * starts it (a time, a file, an email), agents hand the work between them,
 * and it ends on a card the user answers, on the desk or the phone. Ideas
 * that need a code project come last, under "For builders", so the gallery
 * never reads as a coding tool to someone who isn't one.
 *
 * An idea may need something this Mac doesn't have yet (an email app, a
 * folder, GitHub). That is never a dead end: the Chief's first step is to set
 * it up with the user, conversationally (`CHIEF_INSTRUCTIONS`,
 * `src-tauri/src/agents/prompts.rs`), and the gallery line says so up front.
 *
 * None sends by itself: each `text` is a complete brief with one blank at
 * its end, typed into the composer for the user to finish, and nothing goes
 * until they press Send.
 *
 * Shared by the desk (chips and gallery) and the phone (chips).
 *
 * @module companion-protocol/chiefIdeas
 */

export type ChiefIdeaGroup = 'schedule' | 'trigger' | 'together' | 'builders';

export interface ChiefIdea {
  id: string;
  /** The chip and the gallery row's title: a plain starter, no "…" (it types the brief, it doesn't send). */
  label: string;
  /** One line in the gallery: what happens, and what it needs, said honestly. */
  what: string;
  /** Typed into the Chief's composer: a whole brief whose one blank ends it. */
  text: string;
  group: ChiefIdeaGroup;
  /** Asked once, not on a schedule or a trigger: no routine comes of it. */
  oneOff?: true;
}

export const GROUP_LABEL: Record<ChiefIdeaGroup, string> = {
  schedule: 'On a schedule',
  trigger: 'When something happens',
  together: 'Agents together',
  builders: 'For builders',
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
    id: 'invoices',
    label: 'Chase unpaid invoices',
    what: 'Every Monday an agent finds what’s overdue and another drafts a polite reminder for each. You get one card with the list and the drafts, and nothing is sent without your Allow. Your Chief helps you connect where your invoices live first.',
    text: 'Every Monday at 9am, have one agent check which of my invoices are overdue and another draft a polite reminder for each, then send me one card with the list and the drafts. Nothing is sent without my Allow. My invoices are in: ',
    group: 'schedule',
  },
  {
    id: 'social-posts',
    label: 'Draft my social posts',
    what: 'Every Monday a writer drafts the week’s posts from your news and notes, in your voice, and you get them on one card to edit. Nothing is posted without your Allow.',
    text: 'Every Monday at 9am, have a writer draft this week’s social posts from my news and notes, in my voice, and send me one card with the drafts to edit. Nothing is posted without my Allow. Where I post, and what I’m up to: ',
    group: 'schedule',
  },
  {
    id: 'job-search',
    label: 'Help me apply for jobs',
    what: 'Every morning a scout finds new openings that match what you want and a writer drafts a cover letter for the best ones, and a page above the chat keeps every application and where it stands. You pick which to send; nothing is submitted without your Allow.',
    text: 'Every weekday morning, have a scout look for new job openings that match what I want and a writer draft a tailored cover letter for the best few, then send me one card with the openings and the letters. Keep a page above our chat of every application and where it stands, and update it each morning. Nothing is submitted without my Allow. The jobs I want, and my CV: ',
    group: 'schedule',
  },
  {
    id: 'tracker',
    label: 'Track something for me',
    what: 'An agent keeps a page above its chat with the list and where each item stands, updates it when you tell it something, and checks on it every evening. One page that stays current, not a new card each time.',
    text: 'Keep a page above our chat that tracks this: every item and where it stands. Update it whenever I tell you something changed, and every evening check what you can and bring it up to date. What to track: ',
    group: 'schedule',
  },
  {
    id: 'house-hunt',
    label: 'Find me a place to live',
    what: 'Every day an agent checks the listings for new homes that fit your budget and wishlist and sends you a short list with why each made it. Nobody is contacted without your Allow.',
    text: 'Every day at 8am, have an agent check the listings for new homes that fit my budget and wishlist, and send me a short list with a line on why each one made it. Nobody gets contacted without my Allow. What I’m looking for: ',
    group: 'schedule',
  },
  {
    id: 'competitors',
    label: 'Watch my competitors',
    what: 'Every Monday a researcher reads their sites and news, an analyst compares them with last week, and you get one brief: what changed and what to do about it.',
    text: 'Every Monday at 8am, have a researcher read these competitors’ sites and news and an analyst compare them with last week’s notes, then send me one brief: what changed, and what I should do about it. The competitors: ',
    group: 'schedule',
  },
  {
    id: 'inbox',
    label: 'Sort my inbox, draft replies',
    what: 'One agent sorts new email, another drafts the replies worth sending, and nothing is sent without your Allow. Your Chief helps you connect your email first.',
    text: 'Through the day, have one agent sort my new email into needs me, can wait and ignore, and another draft replies to the ones that need me. Nothing is sent without my Allow. My email is in: ',
    group: 'trigger',
  },
  {
    id: 'meeting-notes',
    label: 'Tidy up my meeting notes',
    what: 'When notes or a recording land in a folder you pick, an agent writes up the decisions and to-dos and drafts the follow-up email. Nothing is sent without your Allow.',
    text: 'When new meeting notes or a recording land in a folder, have an agent write up the decisions and who does what, and draft a follow-up email to the people who were there. Nothing is sent without my Allow. The folder to watch: ',
    group: 'trigger',
  },
  {
    id: 'research',
    label: 'Research it and write it up',
    what: 'A researcher gathers sources and a writer turns them into a clear draft with every source linked. Then your Chief asks whether you want it kept up to date each week.',
    text: 'Have a researcher dig into this and collect good sources, and a writer turn them into a clear draft with every source linked. When it’s done, ask me whether I want it kept up to date each week. The topic: ',
    group: 'together',
    oneOff: true,
  },
  {
    id: 'travel',
    label: 'Plan a trip',
    what: 'A researcher finds flights and places to stay in your budget, a planner lays out the days, and every few days they check prices again. Nothing is booked without your Allow.',
    text: 'Plan a trip: have a researcher find flights and places to stay within my budget and a planner lay out the trip day by day, then every few days check the prices again and tell me if something better turns up. Nothing is booked without my Allow. Where, when and my budget: ',
    group: 'together',
  },
  {
    id: 'launch',
    label: 'Run a big project as a team',
    what: 'A planner, a writer and a doer in a room with your Chief, so you talk to the whole team at once, a check-in from them every weekday at 9am, and your Chief keeping the plan. Good for an event, a move or a launch.',
    text: 'Run this as a team: create a planner, a writer and a doer, put them and yourself in a room so I can talk to everyone at once, keep the plan yourself in a file, and every weekday at 9am collect a check-in from each of them and send me one summary with what’s stuck and what needs me. The project: ',
    group: 'together',
  },
  {
    id: 'debate',
    label: 'Have two agents argue it out',
    what: 'Two new agents take opposite sides, each answers the other’s case, and your Chief brings you the verdict.',
    text: 'Create two agents, a Skeptic and a Champion, have them argue this out, each answering the other’s case, and bring me your verdict: ',
    group: 'together',
    oneOff: true,
  },
  {
    id: 'ship-fixes',
    label: 'Ship fixes while I sleep',
    what: 'Each night a fixer takes your top open GitHub issue and fixes it in its own copy, a reviewer checks it, and the morning brings one card: Keep, Review or Discard. Your Chief helps you connect GitHub first.',
    text: 'Every night at 1am, have one agent take the top open GitHub issue in my repo and fix it in its own copy of the project, then have a second agent review the fix. In the morning, give me one card with the change to keep, review or discard. Nothing gets pushed without me. The repo: ',
    group: 'builders',
  },
  {
    id: 'errors',
    label: 'Babysit my errors',
    what: 'Every hour an agent checks a project for new errors, reproduces what broke and fixes it in its own copy, for you to keep or discard. When nothing broke, it says so in a line.',
    text: 'Every hour, check this project for new errors (its dev server, its logs, or an error feed I name), reproduce anything new, fix it in a copy and send me a card to keep or discard. If nothing broke, just say so in one line. The project: ',
    group: 'builders',
  },
  {
    id: 'client-brief',
    label: 'Turn client briefs into sites',
    what: 'When a brief lands in a folder you pick, an agent reads it, starts a project, drafts the site and sends you a card with Preview. Nothing goes to the client.',
    text: 'When a new client brief lands in a folder, read it, start a new project for it, draft the site and send me a card I can preview. Nothing goes to the client without me. The folder to watch: ',
    group: 'builders',
  },
];

/**
 * The chips under the greeting: three everyday jobs that show work running
 * without the user (every morning, on a trigger, a team), one from each
 * group, and that someone who isn't a developer recognises as theirs. The
 * morning brief and the research need nothing set up, so a first result can
 * land in the first minutes. A fixed order: rotating them would make the
 * first screen differ between two people comparing notes, and between a
 * screenshot and the app.
 */
export const CHIEF_CHIP_IDS = ['morning-brief', 'inbox', 'research'] as const;

/** The idea sets up a routine (a time or a trigger), so it runs only while this Mac does. */
export function ideaRepeats(idea: ChiefIdea): boolean {
  return !idea.oneOff;
}

export function findIdea(id: string): ChiefIdea | null {
  return CHIEF_IDEAS.find((idea) => idea.id === id) ?? null;
}

export const CHIEF_CHIPS: readonly ChiefIdea[] = CHIEF_CHIP_IDS.map((id) => findIdea(id)!);

/** The gallery's groups, in order, each with its ideas: everyday jobs first, builders' last. */
export function ideaGroups(): { group: ChiefIdeaGroup; label: string; ideas: ChiefIdea[] }[] {
  return (Object.keys(GROUP_LABEL) as ChiefIdeaGroup[]).map((group) => ({
    group,
    label: GROUP_LABEL[group],
    ideas: CHIEF_IDEAS.filter((idea) => idea.group === group),
  }));
}
