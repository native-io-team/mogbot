import type { ReactNode } from 'react';
import type { PaletteContextKind } from '../components/CommandPalette/paletteContext';

export type CommandCategory =
  | 'action'
  | 'navigation'
  | 'project'
  | 'branch'
  | 'extension'
  | 'settings';

export interface PaletteCtx {
  kind: PaletteContextKind;
  currentProjectName: string | null;
}

/**
 * A single palette-contributed command.
 *
 * Colocate declarations with the feature's handlers via `useCommands()`.
 * Keep `run` idempotent and surface errors via toast — silent failures
 * break user trust in the palette.
 */
export interface Command {
  /** Globally unique, namespaced: `domain.verb` (e.g. `branches.switch`). */
  id: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  /** Extra words to match against during fuzzy search. */
  keywords?: string[];
  /** Display-only shortcut hint (e.g. `⌘⇧P`). Doesn't actually bind the key. */
  shortcut?: string;
  category: CommandCategory;
  /**
   * Context gating — either a single context kind ('home'/'project') or a
   * predicate evaluated fresh at palette-open time. Omit to show everywhere.
   */
  when?: PaletteContextKind | ((ctx: PaletteCtx) => boolean);
  /**
   * Offered only when nothing else matches what was typed, and handed that
   * text: the palette's way on from "no matches" (ask the Chief of Staff).
   * Never ranked among the ordinary results.
   */
  fallback?: boolean;
  /** The handler. Called after the palette has closed; a fallback gets the query. */
  run: (query?: string) => void | Promise<void>;
}

/** How the palette groups results: a category, plus Agents and Recent. */
export type PaletteGroup = CommandCategory | 'agents' | 'recent';

/**
 * The group a command is shown under. Everything about agents and rooms
 * (namespaced `agents.` / `rooms.`) is one group, Agents, whatever category
 * its hook gave it: the app is Agents first, and those commands used to be
 * split between "Navigate" and "Actions" by which hook happened to make them.
 */
export function paletteGroup(cmd: Pick<Command, 'id' | 'category'>): PaletteGroup {
  if (cmd.id.startsWith('agents.') || cmd.id.startsWith('rooms.')) return 'agents';
  return cmd.category;
}

export function matchesContext(when: Command['when'], ctx: PaletteCtx): boolean {
  if (!when) return true;
  if (typeof when === 'string') return when === ctx.kind;
  return when(ctx);
}
