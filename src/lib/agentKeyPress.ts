/**
 * The on-screen answer to an agent's bound key (docs/internal/agent-keys.md,
 * "Shortcuts"): every key drawn for that agent goes down for a beat, as on
 * the site. `data-hit` is styled in agent-key.css.
 *
 * @module lib/agentKeyPress
 */

/** How long a bound-key press holds a key down (the site's beat). */
export const HIT_MS = 220;

/**
 * Presses every key on screen for this agent for a beat, as its bound key is
 * pressed: one timer per press, never per key.
 */
export function pressAgentKeys(agentId: string, root: ParentNode = document): void {
  const keys = root.querySelectorAll<HTMLElement>(
    `.agent-key[data-agent-id="${CSS.escape(agentId)}"]`
  );
  if (keys.length === 0) return;
  keys.forEach((k) => k.setAttribute('data-hit', ''));
  window.setTimeout(() => keys.forEach((k) => k.removeAttribute('data-hit')), HIT_MS);
}
