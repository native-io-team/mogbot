import { useEffect, useRef, useState } from 'react';
import { steadyNext } from '../../packages/companion-protocol/src/steady';

/**
 * A live status line that doesn't flicker: each line holds for a moment
 * (1.8s), and a brief "Thinking" between two steps never flashes up (it must
 * last 2.5s). The phone's rows use the same rule (`steadyNext`, shared in the
 * protocol package). Only the words are steadied; callers keep ticking parts
 * (the elapsed time) outside it. `enabled` false passes the line straight
 * through, so a row that stops working says what it is now at once.
 */
export function useSteadyLine(line: string, enabled = true): string {
  const [shown, setShown] = useState(line);
  // When the shown line went up; set on mount (render must stay pure).
  const shownAt = useRef(0);
  useEffect(() => {
    if (shownAt.current === 0) shownAt.current = Date.now();
    if (line === shown) return;
    // Disabled, the line goes straight through (returned below); `shown`
    // catches up so it is where a steadied line starts when enabled again.
    const waitMs = enabled ? steadyNext(shown, line, shownAt.current, Date.now()).waitMs : 0;
    // Set from a timer, never in the effect body (at once when there is no
    // wait); the effect re-runs on every new line, so `line` is always the
    // latest.
    const t = setTimeout(() => {
      setShown(line);
      shownAt.current = Date.now();
    }, waitMs);
    return () => clearTimeout(t);
  }, [line, shown, enabled]);
  return enabled ? shown : line;
}
