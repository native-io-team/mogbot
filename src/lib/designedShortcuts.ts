/**
 * The keyboard map's page-level keys (designs/keyboard/spec-keyboard-shortcuts.md):
 * a project by its number (⌃⌥⇧1–9), Catch up (⌃⌥C, or ⌃⌥⇧C when an agent holds
 * C), and Allow / Deny on the card in front (⌘↩ / ⌘⌫, only when no text box has
 * focus). ⇧⌘A (Agents / Projects) is the menu's own (`toggle_mode`). Nothing
 * bare, so typing a sentence never fires one. Pure, so every rule is tested.
 *
 * @module lib/designedShortcuts
 */

import { keyLookFor } from '../../packages/companion-protocol/src/agentKeys';
import type { Agent } from './agents';
import { isMac } from './setup';

export interface KeyLike {
  key: string;
  code: string;
  repeat: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}

/** Somewhere typing goes: a field, an editable, a terminal. */
export function takesTyping(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
    return true;
  if (target.closest('[role="textbox"], [role="combobox"], .xterm, .terminal')) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/** The project ⌃⌥⇧ + a digit leads to (0 to 8), or null. `code`, because ⌥⇧ changes `key`. */
export function projectIndexForKey(e: KeyLike): number | null {
  if (e.defaultPrevented || e.repeat) return null;
  if (!e.ctrlKey || !e.altKey || !e.shiftKey || e.metaKey) return null;
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? Number(m[1]) - 1 : null;
}

/** Whether an agent holds the letter C as its key. */
export function agentHoldsC(
  agents: Pick<
    Agent,
    'id' | 'name' | 'role' | 'color' | 'isMain' | 'colorway' | 'icon' | 'boundKey'
  >[]
): boolean {
  return agents.some((a) => keyLookFor(a).boundKey === 'C');
}

/** Whether this press is Catch up: ⌃⌥C, or ⌃⌥⇧C when an agent already holds C. */
export function isCatchUpKey(e: KeyLike, cIsTaken: boolean): boolean {
  if (e.defaultPrevented || e.repeat) return false;
  if (!e.ctrlKey || !e.altKey || e.metaKey || e.code !== 'KeyC') return false;
  return e.shiftKey === cIsTaken;
}

/**
 * What ⌘↩ / ⌘⌫ answer on the card in front, or null: no typing, no other
 * modifier. Mac only: on Windows and Linux the Super key is `metaKey`, and
 * Super+Enter or Super+Backspace must never answer a card there.
 */
export function cardAnswerForKey(
  e: KeyLike,
  doc: Document = document,
  mac: boolean = isMac()
): 'allow' | 'deny' | null {
  if (!mac) return null;
  if (e.defaultPrevented || e.repeat) return null;
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.key !== 'Enter' && e.key !== 'Backspace') return null;
  if (takesTyping(e.target) || takesTyping(doc.activeElement)) return null;
  return e.key === 'Enter' ? 'allow' : 'deny';
}

/**
 * Press Allow or Deny on the card in front: the first approval card still
 * waiting (they carry `data-keys`). The button is clicked, so the card's own
 * guard holds: Allow waits for the card to arm, a busy card ignores it.
 * True when a button was pressed.
 */
export function answerFrontCard(which: 'allow' | 'deny', doc: Document = document): boolean {
  const card = doc.querySelector('[data-keys]');
  const button = card?.querySelector<HTMLButtonElement>(
    which === 'allow' ? '[data-allow]' : '[data-deny]'
  );
  if (!button || button.disabled) return false;
  button.click();
  return true;
}
