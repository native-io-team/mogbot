/**
 * One area of the window (the agents sidebar, a chat pane, a settings
 * section, a dialog's body) in its own error boundary, so a component that
 * throws there leaves the rest of the window working instead of blanking it to
 * the app-level "Something went wrong" (`components/ErrorBoundary.tsx`, which
 * only offers a restart).
 *
 * Every catch is logged as a frontend crash (which reaches the admin agent
 * like any other). A change of `resetKey` clears a caught error, and the
 * default fallback's Try again draws the children again.
 *
 * @module components/primitives/AreaBoundary
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logger } from '../../lib/logger';
import { Button } from './Button';

interface AreaBoundaryProps {
  children: ReactNode;
  /** Where it was caught, for the log ("settings:slack", "dialog"). */
  where: string;
  /** A change clears a caught error (another agent chosen, a dialog reopened). */
  resetKey?: string | number | null;
  /** What shows instead. Default: `AreaError`, a card with one line and Try again. */
  fallback?: (retry: () => void) => ReactNode;
}

interface AreaBoundaryState {
  error: Error | null;
  key: string | number | null | undefined;
}

export class AreaBoundary extends Component<AreaBoundaryProps, AreaBoundaryState> {
  state: AreaBoundaryState = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<AreaBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: AreaBoundaryProps,
    state: AreaBoundaryState
  ): Partial<AreaBoundaryState> | null {
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
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.retry);
    return <AreaError onRetry={this.retry} />;
  }
}

/** The default fallback: a card, one line, Try again. */
export function AreaError({
  onRetry,
  message = 'This part couldn’t be shown. Nothing was lost.',
}: {
  onRetry?: () => void;
  message?: string;
}) {
  return (
    <div className="area-error" role="alert">
      <p className="area-error__line">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="compact" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
