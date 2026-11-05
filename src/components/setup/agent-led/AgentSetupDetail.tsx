/**
 * Per-engine setup after a card is clicked: anything the engine's installer
 * needs first (Codex installs through npm, so Node.js and the package manager
 * come before it), then install, then sign in. The next needed step starts
 * automatically — clicking the card IS the intent — and manual retry stays
 * available through the standard SetupItem rows when something fails or is
 * cancelled. The parent watches the pair and finishes once both are ready.
 */

import { ReactNode, useEffect, useRef } from 'react';
import { SetupItem } from '../SetupItem';
import { TextButton } from '../../primitives/TextButton';
import {
  SETUP_DEPENDENCIES,
  SetupItem as SetupItemType,
  getBlockingDependencies,
} from '../../../lib/setup';

interface AgentSetupDetailProps {
  /** Binary id of the engine being set up (e.g. "claude"). */
  binaryId: string;
  displayName: string;
  icon: ReactNode;
  items: SetupItemType[];
  onItemAction: (itemId: string) => void;
  activeItemId: string | null;
  terminalActive: boolean;
  /** Back to the engine grid. */
  onBack: () => void;
}

/**
 * What has to be installed before `itemId`, deepest first, limited to items
 * the status reports and that aren't ready.
 */
export function missingPrerequisites(itemId: string, items: SetupItemType[]): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    for (const dep of SETUP_DEPENDENCIES[id] ?? []) {
      visit(dep);
      const item = items.find((i) => i.id === dep);
      if (item && item.status !== 'ready' && !out.includes(dep)) out.push(dep);
    }
  };
  visit(itemId);
  return out;
}

export function AgentSetupDetail({
  binaryId,
  displayName,
  icon,
  items,
  onItemAction,
  activeItemId,
  terminalActive,
  onBack,
}: AgentSetupDetailProps) {
  const busy = activeItemId !== null || terminalActive;

  // The rows are fixed for the visit: a prerequisite that turns ready stays
  // on screen, ticked, instead of the list jumping under the user.
  const rowIdsRef = useRef<string[] | null>(null);
  rowIdsRef.current ??= [...missingPrerequisites(binaryId, items), binaryId, `${binaryId}_auth`];
  const rows = rowIdsRef.current
    .map((id) => items.find((i) => i.id === id))
    .filter((item): item is SetupItemType => item !== undefined);
  const prerequisites = rows.filter((r) => r.id !== binaryId && r.id !== `${binaryId}_auth`);

  // Auto-start the next needed step, once per step per visit. Errors and
  // cancellations stop the autopilot — the rows' own buttons take over, so
  // a failing installer can't relaunch itself in a loop.
  const autoStartedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (busy) return;
    const next = rows.find((r) => r.status !== 'ready');
    if (!next) return;
    if (next.status === 'error' || next.status === 'in_progress') return;
    if (getBlockingDependencies(next.id, items).length > 0) return;
    if (autoStartedRef.current.has(next.id)) return;
    autoStartedRef.current.add(next.id);
    onItemAction(next.id);
  }, [busy, rows, items, onItemAction]);

  if (rows.length < 2) return null;

  return (
    <div className="agent-setup-detail">
      <TextButton className="agent-setup-detail-back" onClick={onBack} disabled={busy}>
        ← Choose a different one
      </TextButton>
      <div className="agent-setup-detail-header">
        <span className="agent-pick-card-icon">{icon}</span>
        <div>
          <h2 className="agent-setup-detail-name">{displayName}</h2>
          <p className="agent-setup-detail-sub">
            {prerequisites.length > 0
              ? `${displayName} needs ${prerequisites
                  .map((p) => (p.id === 'homebrew' ? 'a package manager' : p.friendlyName))
                  .join(' and ')} first, so those come before it. Then you sign in once.`
              : 'Install it, then sign in once. Your agents run on it, with your own account.'}
          </p>
        </div>
      </div>
      <div className="wizard-step-items">
        {rows.map((item) => {
          const blockedBy = getBlockingDependencies(item.id, items);
          const isBlocked = blockedBy.length > 0 && item.status !== 'ready';
          const displayItem: SetupItemType = isBlocked ? { ...item, status: 'blocked' } : item;
          return (
            <SetupItem
              key={item.id}
              item={displayItem}
              blockedBy={blockedBy}
              onAction={() => onItemAction(item.id)}
              isActionInProgress={activeItemId === item.id}
              isAnyActionInProgress={busy}
            />
          );
        })}
      </div>
    </div>
  );
}
