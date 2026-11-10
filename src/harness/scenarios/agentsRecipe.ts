/**
 * Share an agent as a recipe (`agents/recipe.rs`, AgentRecipeModal.tsx):
 * the share sheet with what was removed counted, the same sheet with
 * nothing to remove, and the review card a recipe puts up in the Chief's
 * chat when it's dropped on the window or pasted there.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, gateWith, messagesFor, msg, overview } from './agents';
import { RECIPE_REVIEW, recipePreviewFor } from '../fixtures/recipe';

const RECIPE_CARD = () =>
  msg('approval', '', 0, {
    approval: {
      requestId: 'export-review',
      title: 'Bring in 1 agent from a recipe',
      detail:
        "Finance · Keeps the books and chases invoices\nReview on your Mac: each agent's instructions are shown there, and nothing is created until you import them.",
      status: 'pending',
      connector: {
        kind: 'review',
        talkId: 'export-recipe1',
        source: 'a recipe',
        review: RECIPE_REVIEW,
      },
    },
  });

export const agentsRecipeScenarios: Scenario[] = [
  {
    id: 'agents-recipe-share',
    title: 'Agents — Share Finance as a recipe',
    looksRightWhen:
      'A dialog titled “Share Finance as a recipe”: a muted lede (anyone can make their own Finance; it holds what Finance is, never what it knows about you). Finance’s own key (orange, the money legend, as in the sidebar) with its name and role. A quiet recessed line: “4 personal details removed (1 email address, 1 phone number, 2 file paths). 1 password or key removed”. Instructions in a recessed box, with “[removed: …]” where each one was. “Routines · arrive paused” with two; “What it watches for”; “Apps it needs · by name, never your sign-in”: Gmail, Google Sheets, Linear; “Independence”: Suggests Careful. “Not in it” in muted text: memory, conversations, logins, the project, 1 one-time reminder. Footer: Copy as text (outline), Save file… (neutral solid, never the accent).',
    openSelector: AGENTS_TAB,
    requires: '[data-testid="agent-recipe"] .agent-recipe__removed',
    clipSelector: '.agent-recipe-modal',
    steps: [
      { click: '[data-agent-id="finance"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Share as a recipe' },
    ],
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: messagesFor,
      agents_recipe_preview: recipePreviewFor,
    },
  },
  {
    id: 'agents-recipe-share-clean',
    title: 'Agents — a recipe with nothing to remove, from ⌘K',
    looksRightWhen:
      'The same dialog for Lead Gen: no “removed” line at all; its instructions; no routines, watches or apps sections; “Independence: Suggests Steady”; “Not in it” with only memory, conversations and logins.',
    command: 'agents.shareRecipe.leadgen',
    requires: '[data-testid="agent-recipe"]',
    clipSelector: '.agent-recipe-modal',
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: messagesFor,
      agents_recipe_preview: recipePreviewFor,
    },
  },
  {
    id: 'agents-recipe-review',
    title: 'Agents — a recipe dropped on the window: the review card in the Chief’s chat',
    looksRightWhen:
      'In the Chief’s chat, the usual review card “Bring in 1 agent from a recipe” with one row, Finance wearing the recipe’s key (orange, the money legend, the same key the share sheet showed), a neutral “Name taken here” or “New” chip and its instructions. Opened, it lists Routines · arrive paused, What it watches for, Apps it used, and “Independence: Suggests Careful. Used only if that’s stricter than your team’s.” No memory section.',
    command: 'agents.open',
    requires: '[data-testid="agent-import-review"]',
    steps: [
      {
        click:
          '[data-testid="agent-import-review"] .agents-import-agent:first-child .agents-import-agent__row',
      },
    ],
    commands: {
      agents_overview: overview([{ ...TEAM[0], pendingApprovals: 1 }]),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? [...messagesFor(args), RECIPE_CARD()] : messagesFor(args),
      agents_import_talk: gateWith(null),
      agents_import_review_current: RECIPE_REVIEW,
    },
  },
];
