import { Spinner } from '../primitives/Spinner';
import { Button } from '../primitives/Button';

/** Props for the ProjectListStatus component */
interface ProjectListStatusProps {
  /** Background cleanup message, shown under the spinner while scanning */
  cleanupStatus?: string | null;
  /** Set when the scan rejected or timed out; only read once `loading` is false */
  loadError: string | null;
  /** Whether a project scan is in flight */
  loading: boolean;
  /** Re-runs the scan */
  onRetry: () => void;
}

/**
 * The two states the project list can be in other than "showing projects":
 * still scanning, or unable to scan.
 *
 * The error branch exists because there used not to be one. The spinner was
 * cleared only when the scan's promise settled, so a scan that hung left
 * "Loading projects..." up forever with nothing to click and no way to retry —
 * on a cold filesystem cache that was measured at tens of minutes. `loading`
 * deliberately wins over `loadError` so a retry shows the spinner rather than
 * the stale error it is retrying.
 */
export function ProjectListStatus({
  cleanupStatus,
  loadError,
  loading,
  onRetry,
}: ProjectListStatusProps) {
  if (loading) {
    return (
      <div className="project-list-loading">
        <Spinner size="lg" />
        <p className="text-style-body-medium">Loading projects…</p>
        {cleanupStatus && (
          <p className="project-list-cleanup-status text-style-control">{cleanupStatus}</p>
        )}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="project-list-loading" role="alert">
        <p className="text-style-body-medium">Couldn&rsquo;t load your projects.</p>
        <p className="project-list-load-error text-style-control">{loadError}</p>
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  return null;
}
