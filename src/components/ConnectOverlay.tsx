/**
 * Overlay component displayed when a feature requires GitHub authentication.
 *
 * Shows a full-tab overlay with service icon, title, description, and connect button.
 *
 * @module components/ConnectOverlay
 */

import type { ReactNode } from 'react';

import { GitHubIcon } from '@/components/icons';
import { Button } from './primitives/Button';

interface ConnectOverlayProps {
  /** Title text explaining what connection enables */
  title: string;
  /** Description text with more details */
  description: string;
  /**
   * Called when the user clicks the Connect button.
   *
   * Optional: omit it to explain rather than sell. A pane can be unavailable
   * because GitHub isn't connected *or* because the project's remote isn't
   * GitHub at all, and only the first is fixed by connecting. Offering
   * "Connect GitHub" to someone whose code lives on GitLab points them at the
   * wrong problem.
   */
  onConnect?: () => void;
  /** Whether connect action is in progress */
  isConnecting?: boolean;
  /** Defaults to the GitHub mark; pass a neutral one when GitHub isn't the subject. */
  icon?: ReactNode;
}

export function ConnectOverlay({
  title,
  description,
  onConnect,
  isConnecting,
  icon,
}: ConnectOverlayProps) {
  return (
    <div className="connect-overlay">
      <div className="connect-overlay-content">
        <div className="connect-overlay-icon">{icon ?? <GitHubIcon size={48} />}</div>
        <h3 className="connect-overlay-title">{title}</h3>
        <p className="connect-overlay-description">{description}</p>
        {onConnect && (
          <Button variant="primary" onClick={onConnect} disabled={isConnecting}>
            {isConnecting ? 'Connecting…' : 'Connect GitHub'}
          </Button>
        )}
      </div>
    </div>
  );
}
