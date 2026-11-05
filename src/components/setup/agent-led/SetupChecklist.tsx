/**
 * Live verification checklist beside the guided agent terminal.
 *
 * The source of truth for "done" — rows tick green as the app's own
 * `get_full_setup_status` checks pass, never on the agent's say-so.
 */

import { SetupItem, SETUP_FRIENDLY_NAMES } from '../../../lib/setup';
import { SuccessIcon } from '@/components/icons';

interface ChecklistRow {
  id: string;
  label: string;
  ready: boolean;
}

interface SetupChecklistProps {
  items: SetupItem[];
  /** Binary id of the agent chosen in Phase 0, or null for "Other" (no row). */
  agentBinaryId: string | null;
  /** Display name of the chosen agent. */
  agentDisplayName: string;
  /** The items this run sets up, in install order. */
  toolIds: readonly string[];
}

export function SetupChecklist({
  items,
  agentBinaryId,
  agentDisplayName,
  toolIds,
}: SetupChecklistProps) {
  const rows: ChecklistRow[] = [
    // "Other" agents aren’t managed by the app, so there's no row to
    // verify for them — only the required tools below.
    ...(agentBinaryId !== null
      ? [
          {
            id: agentBinaryId,
            label: agentDisplayName,
            ready:
              items.find((i) => i.id === agentBinaryId)?.status === 'ready' &&
              items.find((i) => i.id === `${agentBinaryId}_auth`)?.status === 'ready',
          },
        ]
      : []),
    // Required items, in install order. Absent items (e.g. npm_fix once
    // permissions are fine) simply don't get a row.
    ...toolIds
      .map((id) => items.find((i) => i.id === id))
      .filter((item): item is SetupItem => item !== undefined)
      .map((item) => ({
        id: item.id,
        label: SETUP_FRIENDLY_NAMES[item.id] ?? item.friendlyName,
        ready: item.status === 'ready',
      })),
  ];

  return (
    <div className="agent-setup-checklist" aria-label="Setup progress">
      <h3 className="agent-setup-checklist-title">Setup checklist</h3>
      <p className="agent-setup-checklist-hint">
        The app checks each one itself; they turn green as real checks pass.
      </p>
      <ul className="agent-setup-checklist-items">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`agent-setup-checklist-item ${row.ready ? 'ready' : ''}`}
            aria-label={`${row.label}: ${row.ready ? 'ready' : 'pending'}`}
          >
            {row.ready ? (
              <SuccessIcon
                size={16}
                className="agent-setup-checklist-success-icon"
                aria-hidden="true"
              />
            ) : (
              <span className="agent-setup-checklist-dot" />
            )}
            <span>{row.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
