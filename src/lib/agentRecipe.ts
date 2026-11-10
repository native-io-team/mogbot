/**
 * Share an agent as a recipe (`src-tauri/src/agents/recipe.rs`): its
 * definition (instructions, routines as words, apps by name, its key's look
 * and a suggested independence) with anything personal removed and counted.
 * Never its memory, conversations or logins.
 *
 * Importing one goes through the export path: a recipe file dropped on the
 * window or pasted into the Chief's chat puts the same review card up there.
 *
 * @module lib/agentRecipe
 */

import { invoke } from '@tauri-apps/api/core';
import type { AgentIndependence } from './agents';

export interface RecipeRoutine {
  when: string;
  what: string;
}

/** Exactly what the file holds (schema v1, docs/agents.md "Share an agent as a recipe"). */
export interface Recipe {
  format: 'agent-recipe';
  version: number;
  name: string;
  role: string;
  instructions: string;
  routines: RecipeRoutine[];
  watches: RecipeRoutine[];
  apps: string[];
  look: { colorway?: string; icon?: string; key?: string };
  independence?: AgentIndependence;
}

export interface RecipeRemoved {
  emails: number;
  phones: number;
  paths: number;
  /** Passwords, keys and tokens. */
  secrets: number;
}

export interface RecipePreview {
  recipe: Recipe;
  removed: RecipeRemoved;
  /** What isn't in it on purpose, in the dialog's words. */
  leftOut: string[];
  /** The file's contents, which Save writes only if it's still this. */
  json: string;
  /** "Copy as text": a line saying what it is, and the recipe. */
  text: string;
  fileName: string;
}

export const previewRecipe = (agentId: string) =>
  invoke<RecipePreview>('agents_recipe_preview', { agentId });

export const saveRecipe = (agentId: string, path: string, shown: string) =>
  invoke<void>('agents_recipe_save', { agentId, path, shown });

/** Emitted by the Chief's `share_recipe`: payload is the agent's id. */
export const SHARE_RECIPE_EVENT = 'agents-share-recipe';

export const RECIPE_MENU = 'Share as a recipe…';
export const recipeTitle = (name: string) => `Share ${name} as a recipe`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 personal details removed (an email, a file path)", or null when none were. */
export function removedLine(r: RecipeRemoved): string | null {
  const personal = r.emails + r.phones + r.paths;
  const kinds = [
    r.emails && plural(r.emails, 'email address', 'email addresses'),
    r.phones && plural(r.phones, 'phone number', 'phone numbers'),
    r.paths && plural(r.paths, 'file path', 'file paths'),
  ].filter(Boolean);
  const parts = [
    personal > 0 &&
      `${plural(personal, 'personal detail', 'personal details')} removed (${kinds.join(', ')})`,
    r.secrets > 0 && `${plural(r.secrets, 'password or key', 'passwords or keys')} removed`,
  ].filter(Boolean);
  return parts.length ? parts.join('. ') : null;
}

/** A recipe's JSON, said on its own line or in a fenced block: what the Chief's composer hands to import. */
export function looksLikeRecipe(text: string): boolean {
  return /"format"\s*:\s*"agent-recipe"/.test(text) && /"version"\s*:/.test(text);
}

/** "Finance.mogbot-recipe.json", or any app's recipe file. */
export const isRecipeFile = (path: string) => /-recipe\.json$/i.test(path);
