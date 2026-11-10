/**
 * Every agent is bound to a key (docs/internal/agent-keys.md, "Shortcuts"):
 * pressing it in Agents opens that agent's chat. Only a bare letter or digit,
 * and only when nothing that takes typing has focus (a field, a contenteditable,
 * a terminal) and nothing is open on top (a dialog, a menu, a list of
 * choices). Mounted by Agents only, so the workspace never loses a key.
 *
 * @module hooks/useAgentKeyShortcuts
 */

import { useEffect, useRef } from 'react';
import { keyLookFor, normalizeBoundKey } from '../../packages/companion-protocol/src/agentKeys';
import type { Agent } from '../lib/agents';
import { pressAgentKeys } from '../lib/agentKeyPress';

/** Somewhere typing goes: a field, an editable, a terminal. */
function takesTyping(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
    return true;
  if (target.closest('[role="textbox"], [role="combobox"], .xterm, .terminal')) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/** Something on top owns the keyboard. */
function somethingOnTop(doc: Document): boolean {
  return Boolean(
    doc.querySelector('[aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"]')
  );
}

/** The agent a key press opens, or null when the press isn't one. */
export function agentForKeyEvent(
  event: Pick<
    KeyboardEvent,
    'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'defaultPrevented' | 'target'
  >,
  agents: Pick<
    Agent,
    'id' | 'name' | 'role' | 'color' | 'isMain' | 'colorway' | 'icon' | 'boundKey'
  >[],
  doc: Document = document
): string | null {
  if (event.defaultPrevented || event.repeat) return null;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const key = normalizeBoundKey(event.key);
  if (!key || event.key.length !== 1) return null;
  if (takesTyping(event.target) || takesTyping(doc.activeElement)) return null;
  if (somethingOnTop(doc)) return null;
  return agents.find((a) => keyLookFor(a).boundKey === key)?.id ?? null;
}

export function useAgentKeyShortcuts(agents: Agent[], openAgent: (id: string) => void) {
  const latest = useRef({ agents, openAgent });
  useEffect(() => {
    latest.current = { agents, openAgent };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { agents, openAgent } = latest.current;
      const id = agentForKeyEvent(event, agents);
      if (!id) return;
      event.preventDefault();
      // The key on screen goes down as you press it, then its chat opens.
      pressAgentKeys(id);
      openAgent(id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
