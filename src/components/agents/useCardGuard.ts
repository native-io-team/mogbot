/**
 * Approval cards that resist being answered by accident.
 *
 * - **Armed after a beat.** Allow (and every other yes) is inert for
 *   [`ARM_MS`] after a card appears, so a click aimed at whatever was there a
 *   moment before doesn't land on it.
 * - **Only its own keys answer it.** A click the keyboard produced counts only
 *   if the key went down on that button. Typing in the composer never
 *   answers a card, even if focus moves onto one mid-keystroke (Space
 *   activates a button on key-up, wherever the key-down was).
 *
 * - **Not the click that brought the window forward.** Windows accept the
 *   first mouse, so a click on an unfocused window acts; on a yes it's
 *   ignored instead ([`isFocusClick`]), with a note saying so, and the next
 *   click answers.
 *
 * Deny stays immediate: saying no by accident costs nothing.
 *
 * @module components/agents/useCardGuard
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useOptionalToast } from '../../contexts/ToastContext';
import { FOCUS_CLICK_NOTE, isFocusClick } from '../../lib/firstClick';

export const ARM_MS = 400;

export function useCardGuard(pending: boolean) {
  const [armed, setArmed] = useState(false);
  const keyDownHere = useRef(false);
  const { showToast } = useOptionalToast();
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setArmed(true), ARM_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  /** `run`, if this click is really meant for the button. */
  const guard = useCallback(
    (run: () => void) => (event: MouseEvent<HTMLElement>) => {
      const fromKeyboard = event.detail === 0;
      const keyed = keyDownHere.current;
      keyDownHere.current = false;
      if (!armed || (fromKeyboard && !keyed)) {
        event.preventDefault();
        return;
      }
      if (isFocusClick(event)) {
        event.preventDefault();
        // Never silently: the next click is the one that answers.
        showToast(FOCUS_CLICK_NOTE, 'info');
        return;
      }
      run();
    },
    [armed, showToast]
  );

  /** Spread onto each guarded button. */
  const keyProps = {
    onKeyDown: () => {
      keyDownHere.current = true;
    },
    onBlur: () => {
      keyDownHere.current = false;
    },
    'data-armed': armed || undefined,
  };
  return { armed, guard, keyProps };
}
