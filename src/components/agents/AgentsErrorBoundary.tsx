/**
 * Agents' own error boundaries, so one bad message or one broken pane can't
 * take the whole window down to the app-level "Something went wrong"
 * (`components/ErrorBoundary.tsx`, which only offers a restart).
 *
 * - `PaneBoundary` wraps the main pane (a chat, a room, In flight). The
 *   sidebar stays usable, and choosing another agent (`resetKey`) clears it.
 * - `RowBoundary` wraps one line of a chat's history: a line that fails to
 *   draw becomes one muted line; the rest of the chat is still there.
 *
 * Every catch is logged as an error (which reaches the admin agent like any
 * other frontend crash).
 */

import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { logger } from '../../lib/logger';
import { Button } from '../primitives/Button';

interface Props {
  children: ReactNode;
  /** A change clears a caught error (a different agent or room chosen). */
  resetKey?: string | null;
  /** Where it was caught, for the log. */
  where: string;
  fallback: (retry: () => void) => ReactNode;
}

interface State {
  error: Error | null;
  key: string | null | undefined;
}

class AgentsErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.logError(
      error,
      { where: this.props.where, componentStack: info.componentStack ?? undefined },
      'frontend-crash'
    );
  }

  retry = () => this.setState({ error: null });

  render() {
    return this.state.error ? this.props.fallback(this.retry) : this.props.children;
  }
}

export function PaneBoundary({
  resetKey,
  children,
}: {
  resetKey: string | null;
  children: ReactNode;
}) {
  return (
    <AgentsErrorBoundary
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
    </AgentsErrorBoundary>
  );
}

export function RowBoundary({ children }: { children: ReactNode }) {
  return (
    <AgentsErrorBoundary
      where="agents-row"
      fallback={() => <div className="agents-row-error">This line couldn&apos;t be shown.</div>}
    >
      {children}
    </AgentsErrorBoundary>
  );
}

/** One history row in its own boundary, keeping the row's key. */
export function guardRow(row: ReactElement | null): ReactElement | null {
  return row && <RowBoundary key={row.key ?? undefined}>{row}</RowBoundary>;
}
