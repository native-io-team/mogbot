import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { brandScoped } from './brand';

/**
 * Site migration — types and the data layer behind the Migration panel.
 *
 * The question this feature answers is "does the rebuild still look like the
 * site", and the answer has to be *measured*, not asserted. Everything here is
 * shaped around that: a comparison exists or it doesn't, and one that hasn't
 * been run yet is a state of its own rather than a zero. Inventing a score for
 * a template nobody has compared would be exactly the kind of constructed data
 * the project's first principle forbids.
 *
 * The reads currently resolve against files written by
 * `scripts/site-fidelity.mjs`. In the shipped version they become Tauri
 * commands; the shapes are the contract either way.
 *
 * @module lib/migration
 */

/**
 * The phases, in the order the skill runs them.
 *
 * The order is the method, not a progress bar. Tokens before pages is what
 * makes the work converge instead of drift; one verified page before the rest
 * is what stops a bad structural decision being made twelve times. Showing the
 * phases is therefore not decoration — it is how the user can see that the
 * agent is following the method, and where it currently is inside it.
 */
export type MigrationPhaseId = 'survey' | 'design-system' | 'homepage' | 'templates' | 'remainder';

/**
 * What a phase is doing right now.
 *
 * `blocked` exists separately from `active` on purpose. An agent waiting on an
 * answer and an agent working look identical from outside unless the model
 * distinguishes them, and "it seemed busy" is how a migration quietly stalls
 * for an afternoon.
 */
export type PhaseStatus = 'done' | 'active' | 'blocked' | 'not-started';

export interface MigrationPhase {
  id: MigrationPhaseId;
  label: string;
  status: PhaseStatus;
  /** One line on where this phase actually got to. Never a promise. */
  detail: string;
}

/**
 * Something only the user can settle.
 *
 * The skill's rule is ask rather than substitute, so these are first-class:
 * a question, why it matters, and what the agent would do. A recommendation is
 * required — bringing a decision without one is just handing the work back.
 */
export interface OpenQuestion {
  id: string;
  question: string;
  why: string;
  recommendation: string;
}

/**
 * The four-part answer to "where are we".
 *
 * Every report the agent makes has these parts, and so does this panel, so the
 * screen and the terminal never tell different stories. `notDone` is listed
 * explicitly rather than left as "everything not in `done`" — the difference
 * between a migration that is honest and one that is not is almost entirely
 * whether the gaps are written down somewhere the user looks.
 */
export interface MigrationStatus {
  /** The site being rebuilt. The only input the whole feature takes. */
  sourceUrl: string;
  startedAt: string;
  phases: MigrationPhase[];
  /** What the agent is doing this minute, or null when it is waiting. */
  doing: string | null;
  /** Finished and verified, each with the evidence that says so. */
  done: string[];
  /** Known remaining work. */
  notDone: string[];
  /**
   * What cannot come across at all, and why.
   *
   * Kept apart from `notDone` because they are different promises: one is work
   * outstanding, the other is work that will never happen and that the user
   * has to plan around.
   */
  cannotCarry: { item: string; reason: string }[];
  /** Decisions waiting on the user. A migration with one of these is stalled. */
  needsYou: OpenQuestion[];
}
/** One breakpoint's comparison, at a width the original's own CSS cares about. */
export interface BreakpointComparison {
  breakpoint: number;
  /** Percentage of pixels that match. The worst breakpoint is the template's score. */
  score: number;
  differingPixels: number;
  totalPixels: number;
  /** Full-page heights. A large gap is a layout fault the score understates. */
  referenceHeight: number;
  rebuildHeight: number;
  /** Directory holding reference.png, rebuild.png and diff.png. */
  dir: string;
}

/**
 * A template that has been compared, or one that has not.
 *
 * The discriminant is the point. A template with no comparison has no score,
 * and the UI is required to say so rather than render a placeholder number
 * that reads as a measurement.
 */
export type TemplateFidelity =
  | {
      template: string;
      route: string;
      status: 'compared';
      /** Worst breakpoint, never a mean — an average hides a broken phone layout. */
      score: number;
      capturedAt: string;
      breakpoints: BreakpointComparison[];
    }
  | {
      template: string;
      route: string;
      status: 'not-compared';
      /** Why there is no number yet, in the user's terms. */
      reason: string;
    };

export interface FidelityRun {
  reference: string;
  rebuild: string;
  /** False when the latest run stopped before every width it was asked for. */
  complete: boolean;
  /**
   * Set when the rebuild side is not really a rebuild.
   *
   * The prototype measures the loop against the original page with a
   * stylesheet of deliberate mistakes over it, because there is no generated
   * code to measure yet. That makes both URLs identical, which would read as a
   * broken comparison — so the panel says what it is instead.
   */
  rebuildOverlay: string | null;
  templates: TemplateFidelity[];
  /** One entry per pass of the loop, oldest first. Empty until a second pass. */
  history: { iteration: number; score: number; note: string }[];
}

/** Bands the score is read in. Kept here so the panel and its copy agree. */
export type FidelityBand = 'match' | 'close' | 'off' | 'broken';

/**
 * Where the thresholds come from: the engine's own noise floor is ~0.3% on a
 * page compared against itself, so anything at or above 99.5 is as close as
 * the measurement can tell. Below 95 a person notices without being asked to
 * look, and below 85 the page is not the same page.
 */
export function fidelityBand(score: number): FidelityBand {
  if (score >= 99.5) return 'match';
  if (score >= 95) return 'close';
  if (score >= 85) return 'off';
  return 'broken';
}

export const FIDELITY_BAND_LABEL: Record<FidelityBand, string> = {
  match: 'Matches',
  close: 'Close',
  off: 'Off',
  broken: 'Broken',
};

/** Worst breakpoint across every compared template, or null if none are. */
export function runScore(run: FidelityRun): number | null {
  const scores = run.templates.flatMap((t) => (t.status === 'compared' ? [t.score] : []));
  return scores.length ? Math.min(...scores) : null;
}

/** Raw shape written by the capture script into each run's `report.json`. */
interface FidelityReport {
  label: string;
  reference: string;
  rebuild: string;
  capturedAt: string;
  score: number;
  breakpoints: Omit<BreakpointComparison, 'dir'>[];
  rebuildCss?: string | null;
  /**
   * False when the run was interrupted before every requested width.
   *
   * The report is written after each breakpoint so an interrupted run is not
   * lost, which means a report can legitimately describe two widths when four
   * were asked for. Without this flag a score from half a run reads as a
   * verdict on the whole of it.
   */
  complete?: boolean;
}

/** One run directory as the backend found it. */
interface FidelityRunFile {
  /** Absolute path on disk, or a served path under the UI harness. */
  dir: string;
  report: FidelityReport;
}

/**
 * Turn a capture directory into something an `<img>` can load.
 *
 * Inside the app these are absolute paths in the user's project, which the
 * webview will only load through Tauri's asset protocol. Under the UI harness
 * the same captures are served over HTTP, so the path is already a URL.
 *
 * Feature-detected rather than environment-detected, and that distinction is
 * load-bearing: the harness installs `window.__TAURI_INTERNALS__` through the
 * official `mockIPC`, so testing for that global reports "we are in Tauri"
 * everywhere the captures are *not* behind the asset protocol — which is
 * exactly where converting them produces a URL nothing can load.
 */
export function fidelityImageUrl(dir: string, file: string): string {
  const path = `${dir}/${file}`;
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

/**
 * Every capture run in the project, oldest first.
 *
 * Runs are directories, and the agent names them, so their order is the order
 * the backend returns them in. Nothing here infers a sequence from scores —
 * a pass that made things worse is still the pass that came next, and hiding
 * that would defeat the point of showing the history at all.
 */
export async function loadFidelityRun(projectPath: string): Promise<FidelityRun> {
  const runs = await invoke<FidelityRunFile[]>('read_fidelity_runs', { projectPath });
  if (runs.length === 0) throw new Error('No fidelity runs yet');

  const latest = runs[runs.length - 1];
  const report = latest.report;

  return {
    reference: report.reference,
    rebuild: report.rebuild,
    // Absent in reports written before the flag existed; those were only ever
    // written on completion, so their absence means complete.
    complete: report.complete ?? true,
    rebuildOverlay: report.rebuildCss ?? null,
    // One entry per run, labelled with the run's own directory name. The
    // agent chooses those names, and a name it chose is more informative than
    // an index this function would invent.
    history: runs.map((run, index) => ({
      iteration: index + 1,
      score: run.report.score,
      note: run.dir.split('/').pop() ?? `pass ${index + 1}`,
    })),
    templates: [
      {
        template: report.label,
        route: '/',
        status: 'compared',
        score: report.score,
        capturedAt: report.capturedAt,
        breakpoints: report.breakpoints.map((b) => ({
          ...b,
          dir: `${latest.dir}/${report.label}/${b.breakpoint}`,
        })),
      },
    ],
  };
}

/**
 * The agent's account of itself, or null when this project is not a migration.
 *
 * Null rather than a throw: most projects are not migrations, and asking is a
 * normal thing for the panel to do. Only a *malformed* status is an error,
 * because that one needs fixing and hiding it behind an empty panel is how it
 * would go unnoticed.
 */
export async function loadMigrationStatus(projectPath: string): Promise<MigrationStatus | null> {
  return invoke<MigrationStatus | null>('read_migration_status', { projectPath });
}

/** Prepare a project to have `sourceUrl` rebuilt into it. */
export async function initMigration(projectPath: string, sourceUrl: string): Promise<void> {
  await invoke('init_migration', { projectPath, sourceUrl });
}

/** Phase labels, kept beside the type so the rail and the skill agree. */
export const PHASE_LABEL: Record<MigrationPhaseId, string> = {
  survey: 'Survey',
  'design-system': 'Design system',
  homepage: 'Homepage',
  templates: 'Templates',
  remainder: 'Remainder',
};

/**
 * Where the rebuild is served when nobody has said.
 *
 * The app knows the project's real port and passes it; this is for callers
 * that do not, and it matches the dev-server default so it is right more often
 * than not. Getting it wrong is not silent — the tool refuses to score a URL it
 * could not load.
 */
const REBUILD_URL_FALLBACK = 'http://localhost:3000/';

/**
 * The first thing the agent is told.
 *
 * Deliberately short. The method lives in the `shipstudio-site-to-code` skill,
 * and restating it here would create a second copy to drift — so this names the
 * job, points at the skill, and supplies the two things the skill cannot know
 * on its own: where this project's measuring tool is, and that the panel reads
 * `migration.json`.
 *
 * The last line is the one that matters. An agent that finishes a phase and
 * says nothing has, from the user's side, stalled.
 */
export function buildMigrationPrompt(sourceUrl: string, rebuildUrl = REBUILD_URL_FALLBACK): string {
  return [
    `Rebuild ${sourceUrl} in this project.`,
    '',
    `Use the ${brandScoped('site-to-code')} skill and follow its phases in order:`,
    'survey, then the design system from computed values, then the homepage',
    'verified against the original, then the remaining templates.',
    '',
    'When the survey is done, bring me every decision it raised in one go —',
    'where content should live and whether that means a CMS, where forms should',
    'submit, any font that cannot be self-hosted, anything with no obvious home',
    '— each with the answer you would choose. Ask once, early. If I say you',
    'pick, proceed on your own recommendations without asking again.',
    '',
    'To measure a page against the original:',
    '',
    '  node .shipstudio/fidelity/site-fidelity.mjs \\',
    `    --reference ${sourceUrl} \\`,
    `    --rebuild ${rebuildUrl} \\`,
    '    --breakpoints <widths from the survey> \\',
    '    --label home --out .shipstudio/fidelity/<pass-name>',
    '',
    'It screenshots both sides at those widths and scores the pixel match.',
    'Pass the breakpoints you found in the original\u2019s own media queries —',
    'the tool has defaults, but they are a fallback, not a fact about this site.',
    '',
    'A comparison takes about a minute per width, so iterate on ONE width while',
    'you are fixing things, and run the full set only to confirm a page is done.',
    'Fixing the widest and re-measuring everything each pass wastes most of the',
    'time you have.',
    '',
    'The score says how far off you are. To find out WHAT is off, run:',
    '',
    '  node .shipstudio/fidelity/site-structure.mjs \\',
    `    --reference ${sourceUrl} \\`,
    `    --rebuild ${rebuildUrl} --width <width>`,
    '',
    'It reads both pages\u2019 computed styles and names the differences —',
    'container widths, type sizes and line-heights, colours, section padding.',
    'Diagnose from that, not from the diff image: a single wrong container width',
    'moves every image on the page, so the picture exaggerates one mistake into',
    'a hundred and tells you the name of none of them.',
    'That is the URL this project is configured to serve on. Check it is up',
    'before measuring, and start the dev server yourself if it is not — the tool',
    'needs a URL it can load, and it will tell you plainly if it cannot. Take one throwaway comparison right after the survey to prove',
    'the loop works before anything depends on it. A page is not done below',
    '99.5% at its worst breakpoint.',
    '',
    'The score only goes up. Note it before each pass and check it after: if a',
    'change made it worse, undo that change before trying anything else, and do',
    'not build on top of it. The best score you have seen is a floor. Three',
    'passes with no improvement on it means stop and tell me what is in the way.',
    '',
    'Before marking a phase done, re-read the last report for every page in it',
    'and check the worst breakpoint against the bar — do not rely on what you',
    'remember scoring. And a single width far off while its neighbours match, at',
    'identical page height, is a capture artefact rather than a defect: an image',
    'did not render for that shot, so re-measure it before chasing it.',
    '',
    'When a template lands, re-measure one earlier page that shares components',
    'with it, at one width. Every page after the first is built from parts the',
    'earlier ones use too, and a shared component changes places you are not',
    'looking at. It costs a minute against the cached original.',
    '',
    'Keep .shipstudio/migration.json current as you go. That file is what I',
    'read to see where things are — it is the only way I can see anything, so',
    'treat it as the report rather than as bookkeeping.',
    '',
    'Write it FIRST, before the work: mark a phase "active" and set "doing" to',
    'one line about what you are starting, then get on with it. A survey takes',
    'several minutes and a file that says "not-started" the whole time is',
    'indistinguishable from an agent that never began. Update it again at the',
    'end of each phase, whenever you get stuck, and any time "doing" stops',
    'being true. Keep exactly this shape:',
    '',
    '  {',
    `    "sourceUrl": "${sourceUrl}",`,
    '    "startedAt": "<ISO 8601>",',
    '    "phases": [ { "id": "survey" | "design-system" | "homepage" |',
    '                        "templates" | "remainder",',
    '                  "label": "<name>",',
    '                  "status": "not-started" | "active" | "blocked" | "done",',
    '                  "detail": "<one line on where this phase got to>" } ],',
    '    "doing": "<one line, or null when nothing is in flight>",',
    '    "done": ["<finished and verified>"],',
    '    "notDone": ["<known remaining work>"],',
    '    "cannotCarry": [ { "item": "<what>", "reason": "<why never>" } ],',
    '    "needsYou": [ { "id": "<slug>", "question": "<what you need decided>",',
    '                    "why": "<why it matters now>",',
    '                    "recommendation": "<what you would do>" } ]',
    '  }',
    '',
    'All five phases stay in the array the whole time — their status changes,',
    'they are not added as you reach them, and exactly one is "active": if you',
    'have moved on, close the one behind you first. Two active phases leaves the',
    'panel unable to say where the work actually is, and so does a finished',
    'migration whose "doing" still describes something in flight — clear it to',
    'null when you stop, and put whatever is genuinely outstanding in notDone.',
    '',
    '"needsYou" entries are objects, not',
    'strings, and every one carries a recommendation: bringing me a decision',
    'without one is just handing the work back.',
    '',
    'A "done" entry carries what makes it checkable — "Homepage 99.7% at its',
    'worst breakpoint (479px)" rather than "Homepage done", which is a claim',
    'rather than a result.',
  ].join('\n');
}

/**
 * Picking a migration back up after the agent stopped.
 *
 * A long migration will outlive the session that started it — a context window
 * runs out, a window gets closed, a machine sleeps. The work is not lost when
 * that happens, because `MIGRATION.md` and `migration.json` are on disk and
 * the skill requires them to be current. What was missing was any way to say
 * so: from the user's side an interrupted migration and an abandoned one look
 * identical.
 *
 * Deliberately short, and deliberately not a summary of the state. Repeating
 * what the files say would give the agent two sources that can disagree, and
 * the files are the one that is actually true.
 */
export function buildResumePrompt(sourceUrl: string, rebuildUrl = REBUILD_URL_FALLBACK): string {
  return [
    `Resume the rebuild of ${sourceUrl} in this project. It was interrupted.`,
    '',
    'Before doing anything else, read `.shipstudio/migration.json` and',
    '`MIGRATION.md`. Between them they hold the survey, the plan, what is done,',
    'what is not, and what is waiting on me. Trust those over any assumption',
    'about where things got to.',
    '',
    'Then tell me, briefly, where the work actually stands and what you are',
    'about to do next — before you start doing it. If anything in "needsYou" is',
    'still unanswered, ask me again rather than picking for me.',
    '',
    `Carry on from there under the ${brandScoped('site-to-code')} skill, and keep`,
    '`.shipstudio/migration.json` current in the shape it already uses.',
    '',
    `The rebuild is served at ${rebuildUrl} — check it is up before measuring,`,
    'and start the dev server yourself if it is not.',
  ].join('\n');
}
