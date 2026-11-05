/**
 * DashboardHeader — the presentation-only hero shared by the home-level screens
 * (Home, Workflows, Inbox). Only the headline changes per view. There is no
 * logo here on purpose: the product name and mark are never made prominent.
 *
 * @module components/DashboardHeader
 */

import type { ReactNode } from 'react';
import { EyeOffIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';

interface DashboardHeaderProps {
  /** Called when the user hides the home screen header. */
  onHide?: () => void;
  /**
   * The headline. Home-level screens share this hero and each asks its own
   * question, so the three views read as one app rather than three unrelated
   * destinations.
   */
  title?: ReactNode;
}

export function DashboardHeader({
  onHide,
  title = 'What are we working on?',
}: DashboardHeaderProps) {
  return (
    <header className="dashboard-hero">
      {onHide && (
        <IconButton
          variant="ghost"
          className="dashboard-hero-hide"
          icon={<EyeOffIcon size={14} />}
          onClick={onHide}
          title="Hide home screen header"
          aria-label="Hide home screen header"
        />
      )}
      <h1 className="dashboard-hero-title text-style-h1">{title}</h1>
    </header>
  );
}
