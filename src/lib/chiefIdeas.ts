/**
 * What to ask the Chief of Staff first: the chips under its greeting and the
 * "More ideas…" gallery behind them. One catalogue, so a chip and its row in
 * the gallery always type the same words.
 *
 * Each idea has to work on a brand-new Mac: an engine and nothing else (no
 * apps connected, no GitHub, maybe no Node or Git). Each one lands something
 * visible within a turn or two, or sets up something that keeps going. None
 * sends by itself: the words are typed into the composer, the user finishes
 * or reads them, and presses Send. `CHIEF_INSTRUCTIONS`
 * (`src-tauri/src/agents/prompts.rs`) tells a new Chief what each one wants.
 *
 * @module lib/chiefIdeas
 */

export type ChiefIdeaGroup = 'team' | 'ongoing' | 'make' | 'now';

export interface ChiefIdea {
  id: string;
  /** The chip and the gallery row's title. Ends in "…": it types, it doesn't send. */
  label: string;
  /** One line in the gallery: what happens, said honestly. */
  what: string;
  /** Typed into the Chief's composer. Ending in a space: the user finishes it. */
  text: string;
  group: ChiefIdeaGroup;
  /** Picks a file first and stages it with the words (the document idea). */
  pickFile?: boolean;
}

export const GROUP_LABEL: Record<ChiefIdeaGroup, string> = {
  team: 'A team',
  ongoing: 'Something that keeps going',
  make: 'Something real',
  now: 'Right now',
};

export const SUMMARY_PROMPT =
  'Summarise this for me: the main points, any dates or decisions, and anything I need to do.';

export const CHIEF_IDEAS: readonly ChiefIdea[] = [
  {
    id: 'team',
    label: 'Build me a team…',
    what: 'It suggests a few named agents, each with its own memory, and creates them when you say yes.',
    text: 'Build me a team of agents for this: ',
    group: 'team',
  },
  {
    id: 'debate',
    label: 'Have two agents argue it out…',
    what: 'Two new agents take opposite sides, and you get the verdict back here.',
    text: 'Create two agents, a Skeptic and a Champion, have them argue this out, and bring me the verdict: ',
    group: 'team',
  },
  {
    id: 'brief',
    label: 'Brief me every morning…',
    what: 'A routine on weekday mornings while the app is open, and today’s brief straight away.',
    text: 'Every weekday at 8am, brief me on ',
    group: 'ongoing',
  },
  {
    id: 'watch-page',
    label: 'Watch a page for changes…',
    what: 'A morning routine that tells you only when something on the page has changed.',
    text: 'Check this page every morning and tell me only when something on it changes: ',
    group: 'ongoing',
  },
  {
    id: 'when-pdf',
    label: 'When a PDF lands in Downloads…',
    what: 'A “When…” routine on this Mac: no account needed. macOS may ask to let the app see Downloads.',
    text: 'When a new PDF lands in my Downloads folder, read it and tell me what it is and whether I need to do anything.',
    group: 'ongoing',
  },
  {
    id: 'site',
    label: 'Make me a one-page site…',
    what: 'A new project you can see in the live preview. Nothing to install.',
    text: 'Make me a one-page website for ',
    group: 'make',
  },
  {
    id: 'compare',
    label: 'Compare options in a table…',
    what: 'Comes back as a result card with a file you can keep, and what it would pick.',
    text: 'Compare these and give me a table I can keep, with what you’d pick and why: ',
    group: 'make',
  },
  {
    id: 'document',
    label: 'Summarise a document…',
    what: 'Pick a file: the main points, the dates, and what you need to do.',
    text: SUMMARY_PROMPT,
    group: 'now',
    pickFile: true,
  },
  {
    id: 'research',
    label: 'Research a question…',
    what: 'It searches the web and brings back a short brief with its sources.',
    text: 'Research this and bring me a short brief with sources: ',
    group: 'now',
  },
];

/**
 * The chips under the greeting: a team, a routine, something real. The
 * rest are a click away in the gallery, in a fixed order (rotating them
 * would make the first screen differ between two people comparing notes, and
 * between a screenshot and the app).
 */
export const CHIEF_CHIP_IDS = ['team', 'brief', 'site'] as const;

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
