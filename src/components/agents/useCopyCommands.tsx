/**
 * ⌘K for the live copy-of-the-project card (`AgentCopy.tsx`): "Keep Scout's
 * changes (3 files, +40 −12)", "Review Scout's changes", "Discard Scout's
 * changes…". Registered only while that card is on screen and the agent
 * isn't working in it or being driven by hand. Discard opens the card's own
 * confirm; the palette never discards on its own.
 *
 * @module components/agents/useCopyCommands
 */

import { CheckIcon, FileTextIcon, TrashIcon } from '@/components/icons';
import { useLayoutEffect, useRef } from 'react';
import { useCommands } from '../../commands/useCommands';

export function copyCommandTitle(
  verb: 'Keep' | 'Review' | 'Discard',
  agentName: string,
  stat?: string
): string {
  const base = `${verb} ${agentName}’s changes`;
  if (verb === 'Discard') return `${base}…`;
  return stat ? `${base} (${stat})` : base;
}

export function useCopyCommands({
  agentName,
  stat,
  held,
  onKeep,
  onReview,
  onDiscard,
}: {
  agentName: string;
  stat?: string;
  /** Working in the copy, or driven by hand: nothing to act on yet. */
  held: boolean;
  onKeep: () => void;
  onReview?: () => void;
  onDiscard: () => void;
}) {
  // The newest handlers, so the palette re-registers only when its titles change.
  const latest = useRef({ onKeep, onReview, onDiscard });
  useLayoutEffect(() => {
    latest.current = { onKeep, onReview, onDiscard };
  });
  const canReview = Boolean(onReview);
  useCommands(
    () =>
      held
        ? []
        : [
            {
              id: 'agents.copy.keep',
              title: copyCommandTitle('Keep', agentName, stat),
              icon: <CheckIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'keep', 'merge', 'accept', 'copy', 'changes', 'worktree'],
              run: () => latest.current.onKeep(),
            },
            ...(canReview
              ? [
                  {
                    id: 'agents.copy.review',
                    title: copyCommandTitle('Review', agentName, stat),
                    icon: <FileTextIcon size={14} />,
                    category: 'action' as const,
                    keywords: ['agents', 'review', 'diff', 'changes', 'copy'],
                    run: () => latest.current.onReview?.(),
                  },
                ]
              : []),
            {
              id: 'agents.copy.discard',
              title: copyCommandTitle('Discard', agentName),
              icon: <TrashIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'discard', 'throw away', 'changes', 'copy'],
              run: () => latest.current.onDiscard(),
            },
          ],
    [agentName, stat, held, canReview]
  );
}
