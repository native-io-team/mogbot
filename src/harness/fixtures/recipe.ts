/**
 * Share an agent as a recipe (`agents/recipe.rs`): previews in the shape
 * `agents_recipe_preview` returns (serde camelCase, `built` flattened).
 * Finance's had an email, a file path and a phone number in its text, so
 * its preview counts them; Research's had nothing to remove. Fictional.
 */

import type { RecipePreview } from '../../lib/agentRecipe';

const FINANCE_RECIPE = {
  format: 'agent-recipe' as const,
  version: 1,
  name: 'Finance',
  role: 'Keeps the books and chases invoices',
  instructions:
    'Track every expense in the books sheet at [removed: a file path].\nChase invoices after 14 days; copy the accountant at [removed: an email address].\nIf a client hasn’t paid after 30 days, draft a reminder and ask me before sending.\nUrgent? Call [removed: a phone number].\nAsk before paying anything.',
  routines: [
    { when: 'every weekday at 09:00', what: 'Check for new invoices and file them' },
    { when: 'every month on the 1st at 09:00', what: 'Send me last month’s spending summary' },
  ],
  watches: [{ when: 'a new file appears in [removed: a file path]', what: 'File the receipt' }],
  apps: ['Gmail', 'Google Sheets', 'Linear'],
  look: { colorway: 'teal', icon: 'inbox', key: 'F' },
  independence: 'often' as const,
};

const RESEARCH_RECIPE = {
  format: 'agent-recipe' as const,
  version: 1,
  name: 'Lead Gen',
  role: 'Finds and qualifies leads',
  instructions: 'Find ten companies a week that match our ideal customer and say why each fits.',
  routines: [],
  watches: [],
  apps: [],
  look: { colorway: 'orange', icon: 'search', key: 'L' },
  independence: 'judgement' as const,
};

function preview(
  recipe: RecipePreview['recipe'],
  removed: RecipePreview['removed'],
  extra: string[]
) {
  const json = JSON.stringify(recipe, null, 2) + '\n';
  return {
    recipe,
    removed,
    leftOut: [
      'Its memory and everything it knows about you',
      'Its conversations',
      'Logins, keys and which accounts it uses',
      ...extra,
    ],
    json,
    text: `An agent recipe for ${recipe.name}. To use it, paste all of this into the Chief of Staff's chat.\n\n\`\`\`json\n${json}\`\`\`\n`,
    fileName: `${recipe.name}.mogbot-recipe.json`,
  } satisfies RecipePreview;
}

export const FINANCE_PREVIEW = preview(
  FINANCE_RECIPE,
  { emails: 1, phones: 1, paths: 2, secrets: 1 },
  ['The project it works in', '1 one-time reminder']
);

export const CLEAN_PREVIEW = preview(
  RESEARCH_RECIPE,
  { emails: 0, phones: 0, paths: 0, secrets: 0 },
  []
);

export const recipePreviewFor = (args: Record<string, unknown>) =>
  args.agentId === 'finance' ? FINANCE_PREVIEW : { ...CLEAN_PREVIEW };

/** The review card a dropped or pasted recipe puts up in the Chief's chat. */
export const RECIPE_REVIEW = {
  proposals: [
    {
      key: 'x0',
      name: 'Finance',
      role: FINANCE_RECIPE.role,
      instructions: FINANCE_RECIPE.instructions,
      memory: '',
      routines: FINANCE_RECIPE.routines.map((r) => ({ ...r, schedule: r.when })),
      logins: [],
      watches: FINANCE_RECIPE.watches,
      apps: FINANCE_RECIPE.apps.map((name) => ({ name, purpose: '' })),
      preferences: '',
      context: '',
      look: { colorway: 'teal', icon: 'inbox', key: 'F', independence: 'often' },
    },
  ],
};
