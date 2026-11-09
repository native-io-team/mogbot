/**
 * Agents' own error boundaries, so one bad message or one broken pane can't
 * take the whole window down to the app-level "Something went wrong"
 * (`components/ErrorBoundary.tsx`, which only offers a restart). All of them
 * are `primitives/AreaBoundary` with the Agents wording.
 *
 * - `PaneBoundary` wraps the main pane (a chat, a room, In flight). The
 *   sidebar stays usable, and choosing another agent (`resetKey`) clears it.
 * - `SidebarBoundary` wraps the agents list (and the account switcher under
 *   it), so a bad agent entry leaves the chat open, with Try again.
 * - `SectionBoundary` wraps one Settings → Agents section: the others still
 *   show and still work.
 * - `RowBoundary` wraps one line of a chat's history: a line that fails to
 *   draw becomes one muted line; the rest of the chat is still there.
 *
 * Every catch is logged as an error (which reaches the admin agent like any
 * other frontend crash).
 */

import type { ReactElement, ReactNode } from 'react';
import { AreaBoundary, AreaError } from '../primitives/AreaBoundary';
import { Button } from '../primitives/Button';

export function PaneBoundary({
  resetKey,
  children,
}: {
  resetKey: string | null;
  children: ReactNode;
}) {
  return (
    <AreaBoundary
      where="agents-pane"
      resetKey={resetKey}
      fallback={(retry) => (
        <div className="agents-main__state agents-main__state--error" role="alert">
          <p>This couldn&apos;t be shown. Nothing was lost.</p>
          <Button onClick={retry}>Try again</Button>
        </div>
      )}
    >
      {children}
    </AreaBoundary>
  );
}

export function SidebarBoundary({
  part = 'agents',
  message = 'The list of agents couldn’t be shown.',
  children,
}: {
  /** For the log: which part of the sidebar ("agents", "accounts"). */
  part?: string;
  message?: string;
  children: ReactNode;
}) {
  return (
    <AreaBoundary
      where={`agents-sidebar:${part}`}
      fallback={(retry) => <AreaError message={message} onRetry={retry} />}
    >
      {children}
    </AreaBoundary>
  );
}

export function SectionBoundary({ name, children }: { name: string; children: ReactNode }) {
  return (
    <AreaBoundary
      where={`settings:${name}`}
      fallback={(retry) => (
        <AreaError message="This setting couldn’t be shown. Nothing was changed." onRetry={retry} />
      )}
    >
      {children}
    </AreaBoundary>
  );
}

export function RowBoundary({ children }: { children: ReactNode }) {
  return (
    <AreaBoundary
      where="agents-row"
      fallback={() => <div className="agents-row-error">This line couldn&apos;t be shown.</div>}
    >
      {children}
    </AreaBoundary>
  );
}

/** One history row in its own boundary, keeping the row's key. */
export function guardRow(row: ReactElement | null): ReactElement | null {
  return row && <RowBoundary key={row.key ?? undefined}>{row}</RowBoundary>;
}
