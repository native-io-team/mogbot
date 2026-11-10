/**
 * A and D on an approval card: Allow and Deny from the keyboard, the y/n a
 * CLI user expects. Only while that card has focus (a click on it, or Tab to
 * its buttons), never from anywhere else: a one-key yes anywhere would be a
 * reflex yes on a card not read. The keys are shown as hints only while the
 * card has focus, and Allow from the key still waits for the card to arm
 * (`useCardGuard`), as a click does.
 *
 * @module components/agents/approvalKeys
 */

export type ApprovalKey = 'allow' | 'deny';

interface KeyLike {
  key: string;
  repeat: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}

/** What a key on a focused card answers, if anything. Pure. */
export function approvalKey(event: KeyLike): ApprovalKey | null {
  if (event.defaultPrevented || event.repeat) return null;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  // Typing in the card's own note field is typing.
  const target = event.target as HTMLElement | null;
  if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return null;
  const key = event.key.toLowerCase();
  if (key === 'a') return 'allow';
  if (key === 'd') return 'deny';
  return null;
}
