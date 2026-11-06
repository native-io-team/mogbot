import { useEffect, useRef, useState } from 'react';
import { steadyNext } from '@shipstudio/companion-protocol';

// The rule is shared with the desk's sidebar (`packages/companion-protocol/src/steady.ts`).
export { STEADY_HOLD_MS, THINKING_GRACE_MS, steadyNext } from '@shipstudio/companion-protocol';

/**
 * A live status line that doesn't flicker: each line holds for a moment, and
 * a brief "Thinking" between two steps never flashes up. Only the head is
 * steadied; callers keep ticking parts (" · 1m") outside it.
 */
export function useSteadyLine(line: string, enabled = true): string {
  const [shown, setShown] = useState(line);
  const shownAt = useRef(Date.now());
  const latest = useRef(line);
  latest.current = line;
  useEffect(() => {
    if (!enabled) {
      setShown(line);
      shownAt.current = Date.now();
      return;
    }
    const { show, waitMs } = steadyNext(shown, line, shownAt.current, Date.now());
    if (waitMs === 0) {
      if (show !== shown) {
        setShown(show);
        shownAt.current = Date.now();
      }
      return;
    }
    const t = setTimeout(() => {
      setShown(latest.current);
      shownAt.current = Date.now();
    }, waitMs);
    return () => clearTimeout(t);
  }, [line, shown, enabled]);
  return enabled ? shown : line;
}
