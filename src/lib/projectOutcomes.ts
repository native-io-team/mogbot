/**
 * What a new project is *for*, ahead of what it is built with. New project
 * leads with these four; the frameworks behind each sit under "More options",
 * so someone who wants a website never has to know what SvelteKit is.
 *
 * @module lib/projectOutcomes
 */

import type { Template } from '../hooks/useProjectCreation';

export type ProjectOutcomeId = 'website' | 'store' | 'mobile' | 'blank';

export interface ProjectOutcome {
  id: ProjectOutcomeId;
  name: string;
  description: string;
  /** The templates that make this outcome, preferred first. */
  templateIds: readonly string[];
}

export const PROJECT_OUTCOMES: readonly ProjectOutcome[] = [
  {
    id: 'website',
    name: 'Website',
    description: 'A site or a web app.',
    templateIds: [
      'nextjs-basic',
      'nextjs-plain-css',
      'astro-html',
      'astro-basic',
      'sveltekit-basic',
      'html-basic',
    ],
  },
  {
    id: 'store',
    name: 'Online store',
    description: 'A Shopify theme, previewed against your store.',
    templateIds: ['shopify-theme'],
  },
  {
    id: 'mobile',
    name: 'Mobile app',
    description: 'An app for iPhone and Android.',
    templateIds: ['expo-mobile', 'react-native-mobile', 'flutter-mobile'],
  },
  {
    id: 'blank',
    name: 'Blank',
    description: 'An empty folder to start from nothing.',
    templateIds: ['blank'],
  },
];

/** The outcomes this build can make: those with at least one template available. */
export function availableOutcomes(templates: readonly Template[]): ProjectOutcome[] {
  const ids = new Set(templates.map((t) => t.id));
  return PROJECT_OUTCOMES.filter((o) => o.templateIds.some((id) => ids.has(id)));
}

/** The outcome a template belongs to, if any (Eve agent belongs to none). */
export function outcomeFor(templateId: string | null | undefined): ProjectOutcome | null {
  if (!templateId) return null;
  return PROJECT_OUTCOMES.find((o) => o.templateIds.includes(templateId)) ?? null;
}

/**
 * The template to use when an outcome is picked: the current selection when
 * it already belongs to it, else the saved default when that does, else the
 * outcome's first available template.
 */
export function templateForOutcome(
  outcome: ProjectOutcome,
  templates: readonly Template[],
  current: string | null,
  savedDefault: string | null
): Template | null {
  const inOutcome = (id: string | null) => id !== null && outcome.templateIds.includes(id);
  const byId = (id: string | null) => templates.find((t) => t.id === id) ?? null;
  if (inOutcome(current) && byId(current)) return byId(current);
  if (inOutcome(savedDefault) && byId(savedDefault)) return byId(savedDefault);
  for (const id of outcome.templateIds) {
    const t = byId(id);
    if (t) return t;
  }
  return null;
}
