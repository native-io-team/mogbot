/**
 * Site-migration scenarios.
 *
 * The Migration panel reads its captures out of the open project, so the
 * fixtures below stand in for that read — but the *images* they point at are
 * real, served from `harness/migration-demo`: real screenshots of a real site
 * against a rebuild with real mistakes in it. Faking those would defeat the
 * review, since what the panel is for is looking at them.
 */

import type { Scenario } from '../types';
import { workspaceCommands, WORKSPACE_PROJECT } from './workspace';

/**
 * Runs as `read_fidelity_runs` returns them: oldest first, in the natural
 * order of their directory names. The panel opens on the last one.
 */
const FIDELITY_RUNS = [
  {
    dir: '/migration-demo/v1',
    report: run(89.25, 'rebuild-v1.css', [
      bp(1440, 89.25, 1_944_863, 18_083_520, 12_558, 12_482),
      bp(991, 92.19, 1_169_461, 14_973_019, 15_085, 15_109),
      bp(767, 92.31, 1_197_918, 15_570_100, 20_268, 20_300),
      bp(479, 89.87, 849_066, 8_382_500, 17_464, 17_500),
    ]),
  },
  {
    dir: '/migration-demo/v2',
    report: run(89.87, 'rebuild-v2.css', [
      bp(1440, 95.45, 822_641, 18_083_520, 12_558, 12_548),
      bp(991, 92.19, 1_169_461, 14_973_019, 15_085, 15_109),
      bp(767, 92.47, 1_171_918, 15_570_100, 20_268, 20_300),
      bp(479, 89.87, 849_066, 8_382_500, 17_464, 17_500),
    ]),
  },
];

function bp(
  breakpoint: number,
  score: number,
  differingPixels: number,
  totalPixels: number,
  referenceHeight: number,
  rebuildHeight: number
) {
  return { breakpoint, score, differingPixels, totalPixels, referenceHeight, rebuildHeight };
}

function run(score: number, rebuildCss: string, breakpoints: ReturnType<typeof bp>[]) {
  return {
    label: 'home',
    reference: 'https://tempo-template.webflow.io/',
    rebuild: 'https://tempo-template.webflow.io/',
    rebuildCss,
    capturedAt: '2026-09-08T01:26:28.924Z',
    score,
    breakpoints,
  };
}

const MIGRATION_STATUS = {
  sourceUrl: 'https://tempo-template.webflow.io/',
  startedAt: '2026-09-07T19:04:00.000Z',
  phases: [
    {
      id: 'survey',
      label: 'Survey',
      status: 'done',
      detail: '18 URLs across 4 templates. Breakpoints read from the site: 1440 / 991 / 767 / 479.',
    },
    {
      id: 'design-system',
      label: 'Design system',
      status: 'done',
      detail: '31 tokens from computed styles. Style guide at /style-guide; written to CLAUDE.md.',
    },
    {
      id: 'homepage',
      label: 'Homepage',
      status: 'active',
      detail: '89.9% at its worst breakpoint after 2 passes. Not accepted below 99.5%.',
    },
    {
      id: 'templates',
      label: 'Templates',
      status: 'not-started',
      detail: '3 templates queued. Not begun until the homepage is signed off.',
    },
    {
      id: 'remainder',
      label: 'Remainder',
      status: 'not-started',
      detail: 'Written at the end, from what is still open.',
    },
  ],
  doing:
    'Homepage, pass 3 — the container fix did not reach 479px; looking at the mobile type scale.',
  done: [
    'Survey — 18 URLs grouped into 4 templates, written to MIGRATION.md',
    'Design system — 31 tokens taken from computed styles, not sampled by eye',
    'Style guide route at /style-guide, rendering every token',
  ],
  notDone: [
    'Homepage is at 89.9% at 479px and is not accepted below 99.5%',
    'about, work and the post template have not been started',
    'No interactive states checked yet — hover, focus, open menu',
    'Nothing checked between breakpoints, only at them',
  ],
  cannotCarry: [
    {
      item: 'Scroll and load interactions',
      reason:
        "Webflow's IX2 has no export format. They need rebuilding by hand, and are not counted in any score.",
    },
    {
      item: 'The heading typeface',
      reason:
        'Served from a CDN under a licence that does not cover self-hosting. A substitute needs your decision.',
    },
  ],
  needsYou: [
    {
      id: 'font',
      question: 'The heading font cannot be self-hosted. Which way do you want to go?',
      why: 'It sets the look of every page, so it is worth settling before the other three templates are built rather than after.',
      recommendation:
        'License it directly — it is the only option that keeps the site looking like itself. Otherwise the closest free substitute is a near match at display sizes and visibly different in body copy.',
    },
  ],
};

/**
 * A migration that finished, taken verbatim from one that did.
 *
 * The completed state is the one that most needs looking at, because it is the
 * one a user trusts — and the temptation in a fixture is to write it as
 * everything green and nothing outstanding. A real finished migration is not
 * that. This one matched at 100% across every width and still ended with three
 * things it could not carry and three questions it had raised and not had
 * answered, which is what an honest "done" looks like.
 */
const COMPLETED_STATUS = {
  sourceUrl: 'https://motherfuckingwebsite.com/',
  startedAt: '2026-09-08T00:26:00.000Z',
  phases: [
    {
      id: 'survey',
      label: 'Survey',
      status: 'done',
      detail: 'One page, one template, zero CSS, zero media queries, no links.',
    },
    {
      id: 'design-system',
      label: 'Design system',
      status: 'done',
      detail: 'main.css written from the measured computed values, not sampled by eye.',
    },
    {
      id: 'homepage',
      label: 'Homepage',
      status: 'done',
      detail: '100% at 1440/991/767/479, page heights identical on both sides.',
    },
    {
      id: 'templates',
      label: 'Templates',
      status: 'done',
      detail: 'Only one template, and it is the homepage — the source has no links.',
    },
    {
      id: 'remainder',
      label: 'Remainder',
      status: 'done',
      detail: 'Production build succeeds and emits the single route.',
    },
  ],
  doing: null,
  done: [
    'Homepage 100% at every width (1440/991/767/479), heights identical',
    'Built output verified too — 100% against dist, not just the dev server',
    'Design system taken from computed values: Times/16px, UA defaults measured',
    'Established the source ships zero CSS and zero media queries',
  ],
  notDone: [],
  cannotCarry: [
    {
      item: 'Google Analytics (classic analytics.js, UA-45956659-1)',
      reason: 'Universal Analytics was shut down in 2023 and the property is not ours.',
    },
    {
      item: 'The apex host as the fidelity reference',
      reason:
        'Its TLS endpoint rejects the handshake from every client on this machine, so the comparison runs against a local mirror of the same bytes.',
    },
    {
      item: 'Author breakpoints',
      reason:
        'The source has no media queries at all — it argues in its own copy that it needs none.',
    },
  ],
  needsYou: [
    {
      id: 'mirror',
      question:
        'Is it acceptable that fidelity is measured against a local mirror of the site’s own bytes rather than the live host?',
      why: 'The live host will not complete a TLS handshake from here, so the alternative is not measuring at all.',
      recommendation:
        'Accept it. The mirror is the server’s own response bytes, so the comparison is against the same HTML the site serves.',
    },
    {
      id: 'copy',
      question: 'Should the rebuild keep the original’s body copy, or drop in placeholder text?',
      why: 'The copy is the site’s entire content, and it is someone else’s writing.',
      recommendation:
        'Keep it for now and mark it in MIGRATION.md as text to replace before publishing.',
    },
    {
      id: 'widths',
      question: 'Which widths should count as the pass/fail set?',
      why: 'The source has no media queries, so any set is a choice rather than something read off the site.',
      recommendation:
        'The four defaults. They span the range without asserting the source cares about them.',
    },
  ],
};

export const migrationScenarios: Scenario[] = [
  {
    id: 'migration-fidelity',
    command: 'migration.fidelity',
    requires: '.mig-matrix',
    title: 'Migration — where the work actually is',
    looksRightWhen:
      'The phase rail shows the method and where the agent is inside it. The open question is unmissable, because while one is open the migration is stopped, not slow. Done / Doing / Not done / Can’t carry all render even when empty. The headline is 89.9% — the 479px cell — even though 1440 improved to 95.5%: the worst breakpoint leads, and an average here would have read as progress.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      read_migration_status: MIGRATION_STATUS,
      read_fidelity_runs: FIDELITY_RUNS,
      // Asked for by the preview toolbar the moment a workspace mounts. Not
      // this panel's concern, but an unanswered command fails the capture, and
      // a screenshot from a run with unmocked commands is not evidence.
      get_element_breadcrumb_enabled: false,
    },
  },
  {
    id: 'migration-done',
    command: 'migration.fidelity',
    requires: '.mig-report',
    title: 'Migration — finished, and still honest about the gaps',
    looksRightWhen:
      'Every phase is done and the score is 100%, and the panel still shows three things that could not come across and three questions that were never answered. A finished migration is not an empty right-hand column, and a panel that renders one is hiding the part the user most needs on handover.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      read_migration_status: COMPLETED_STATUS,
      read_fidelity_runs: [
        {
          dir: '/migration-demo/v1',
          report: {
            label: 'home',
            reference: 'https://motherfuckingwebsite.com/',
            rebuild: 'http://localhost:4321/',
            rebuildCss: null,
            capturedAt: '2026-09-08T00:50:00.000Z',
            complete: true,
            score: 100,
            breakpoints: [
              bp(1440, 100, 0, 18_083_520, 2_140, 2_140),
              bp(991, 100, 0, 14_973_019, 2_640, 2_640),
              bp(767, 100, 0, 15_570_100, 3_180, 3_180),
              bp(479, 100, 0, 8_382_500, 4_620, 4_620),
            ],
          },
        },
      ],
      get_element_breadcrumb_enabled: false,
    },
  },
  {
    id: 'migration-interrupted',
    command: 'migration.fidelity',
    requires: '.mig-report',
    title: 'Migration — surveyed and planned, nothing measured yet',
    looksRightWhen:
      'The state renders in full with no comparison at all, because the two halves are independent: this is what a migration looks like when the agent has surveyed the site and got cut off. Resume is offered, Compare again is not, and the score reads “Not measured yet” rather than a number nobody produced. A question written as a bare sentence shows the sentence and no empty Suggestion label.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      // The shape a real agent wrote: a status word outside the vocabulary and
      // questions as sentences. Both are normalised by the backend, and this
      // is where that stays true.
      read_migration_status: {
        ...MIGRATION_STATUS,
        // Exactly one phase is current — the state a real interrupted run is
        // in, and the state the rail is drawn for.
        phases: MIGRATION_STATUS.phases.map((p) => {
          if (p.id === 'design-system') {
            return { ...p, status: 'active', detail: '31 tokens read; not yet ported.' };
          }
          if (p.id === 'homepage') {
            return { ...p, status: 'not-started', detail: 'Not started.' };
          }
          return p;
        }),
        needsYou: [
          {
            id: 'q0',
            question: 'Fonts: self-host the same files, or substitute?',
            why: '',
            recommendation: '',
          },
        ],
      },
      read_fidelity_runs: [],
      get_element_breadcrumb_enabled: false,
    },
  },
  {
    id: 'migration-start',
    startOn: 'projects',
    // Driven by clicks rather than by a command: the harness runs a scenario's
    // `steps` before its `command`, so a step can never reach a control inside
    // a modal that the command is what opens. Both of these are reachable from
    // the dashboard without one.
    openSelector: '[data-education-id="new-project-button"]',
    steps: [{ click: '.create-tabs .tabs__tab:nth-child(3)' }],
    requires: '.mig-rail--compact',
    title: 'Migration — starting from a URL',
    looksRightWhen:
      'One field and a stack to build it in, both wearing the create modal\u2019s own furniture rather than this tab\u2019s inventions. The five phases appear as the same rail the Migration panel fills in later, so they are recognisable when the user meets them again.',
    commands: {},
  },
];
