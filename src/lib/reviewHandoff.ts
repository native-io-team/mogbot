/**
 * Handing "Open a pull request" from an agent's change card to the workspace.
 *
 * The card lives in Agents mode; the pull request flow (`SubmitReviewModal`,
 * which commits, writes the description and creates the PR only when the user
 * presses Submit) lives in the workspace. So the card opens the agent's copy
 * of the project as a workspace and leaves the request here, and the
 * workspace opens the modal once it is showing that copy on that branch.
 *
 * A one-slot queue, like `promptHandoff`, because the two ends are far
 * apart and the trip (mounting a workspace, reading its branch) is async.
 *
 * @module lib/reviewHandoff
 */

interface PendingReview {
  projectPath: string;
  branch: string;
  queuedAt: number;
}

/** Long enough for a cold project open; short enough not to ambush later. */
const TTL_MS = 60_000;

let pending: PendingReview | null = null;

/** Ask for the pull request modal once `projectPath` is open on `branch`. */
export function queueSubmitReview(projectPath: string, branch: string): void {
  pending = { projectPath, branch, queuedAt: Date.now() };
}

/**
 * The queued branch for `projectPath` when it is now on that branch, taken
 * (so it opens once). `null` otherwise; an expired request is dropped.
 */
export function takeSubmitReview(
  projectPath: string | null,
  currentBranch: string | null
): string | null {
  if (!pending) return null;
  if (Date.now() - pending.queuedAt > TTL_MS) {
    pending = null;
    return null;
  }
  if (pending.projectPath !== projectPath || pending.branch !== currentBranch) return null;
  const { branch } = pending;
  pending = null;
  return branch;
}

/** Test-only: forget anything queued. */
export function resetReviewHandoff(): void {
  pending = null;
}
