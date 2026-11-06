import { Component, ReactNode } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { logger } from '../lib/logger';
import { Button } from './primitives/Button';
import { InfoIcon } from '@/components/icons';
import { asCommandError, formatCommandError } from '../lib/errors';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.logError(
      error,
      { componentStack: errorInfo.componentStack ?? undefined },
      'frontend-crash'
    );

    // The logError above also reports the crash to the admin agent
    // (logger forwards error-level logs — see docs/error-reporting.md).
  }

  handleRestart = async () => {
    try {
      await relaunch();
    } catch (err) {
      // In dev mode, relaunch might not work - try window reload
      logger.error('Relaunch failed, trying reload', {
        error: formatCommandError(asCommandError(err)),
      });
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary__icon">
            <InfoIcon size={48} />
          </div>
          <h1 className="error-boundary__title">Something went wrong</h1>
          <p className="error-boundary__message">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <p className="error-boundary__report-status">
            Check Settings &amp; Help → Report a bug for confirmed automatic reports, or report this
            problem yourself.
          </p>
          <div className="error-boundary__actions">
            <Button variant="primary" onClick={() => void this.handleRestart()}>
              Restart App
            </Button>
          </div>
          {this.state.error && (
            <details className="error-boundary__details">
              <summary className="error-boundary__summary">Technical details</summary>
              <pre className="error-boundary__stack">
                {this.state.error.stack || this.state.error.message}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
