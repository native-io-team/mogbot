/**
 * Opens the pull request modal a change card asked for (`lib/reviewHandoff`)
 * once the workspace is showing that project on that branch.
 *
 * @module hooks/useReviewHandoff
 */

import { useEffect } from 'react';
import { takeSubmitReview } from '../lib/reviewHandoff';

export function useReviewHandoff(
  projectPath: string | null,
  currentBranch: string | null,
  openSubmitReview: (branch: string) => void
): void {
  useEffect(() => {
    const branch = takeSubmitReview(projectPath, currentBranch);
    if (branch) openSubmitReview(branch);
  }, [projectPath, currentBranch, openSubmitReview]);
}
