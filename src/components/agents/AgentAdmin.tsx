/**
 * Admins on the desk (`lib/agentAdmin`, `agents/admin.rs`):
 *
 * - **Settings → Independence → Admins**: one switch per agent ("Admin — can
 *   manage and approve for other agents"), on for the Chief of Staff by
 *   default; what admins did (Admin activity); and Recently deleted, where
 *   an agent an admin removed waits 30 days with Restore.
 * - **The agent editor**: the same switch, immediate like Revoke.
 * - **In the chat**: an admin's "3 things only you can decide" message,
 *   each card answered in place for the agent that asked
 *   (`DecideCards`). The live card is read from that agent's chat when it
 *   has loaded, so it resolves wherever it was answered.
 *
 * @module components/agents/AgentAdmin
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../primitives/Button';
import { ApprovalCard } from './AgentChatItems';
import { Row, Toggle } from './AgentSettingsRows';
import { answerApproval, type Agent, type AgentMessage } from '../../lib/agents';
import {
  ADMIN_DETAIL,
  adminActivity,
  isAdmin,
  recentlyDeleted,
  restorableLine,
  restoreAgent,
  setAdmin,
  type AdminActivity,
  type DeletedAgent,
} from '../../lib/agentAdmin';
import { loadMessages, refreshAgents, useAgentsSelector } from '../../lib/agentsStore';
import { takeSettingsSectionRequest } from '../../lib/settings';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { clockFormat } from '../../../packages/companion-protocol/src/clock';

const when = (ts: number) =>
  clockFormat({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ts);

function useAdminSwitch() {
  const { showToast } = useOptionalToast();
  const [saving, setSaving] = useState<string | null>(null);
  const change = useCallback(
    async (agent: Agent, on: boolean) => {
      setSaving(agent.id);
      try {
        await setAdmin(agent.id, on);
        await refreshAgents();
      } catch (e) {
        showToast(formatCommandError(asCommandError(e)), 'error');
      } finally {
        setSaving(null);
      }
    },
    [showToast]
  );
  return { saving, change };
}

/**
 * Edit agent's row: the same switch, saved at once. What it lets an admin do
 * is the On its own group's footnote.
 */
export function AdminRow({ agent }: { agent: Agent }) {
  const live = useAgentsSelector((s) => s.agents?.find((a) => a.id === agent.id)) ?? agent;
  const { saving, change } = useAdminSwitch();
  return (
    <Row label="Admin">
      <Toggle
        on={isAdmin(live)}
        label="Admin — can manage and approve for other agents"
        onChange={(on) => saving === null && void change(live, on)}
      />
    </Row>
  );
}

/** The editor's switch: saved at once, not with the draft. */
export function AdminSwitch({ agent }: { agent: Agent }) {
  const live = useAgentsSelector((s) => s.agents?.find((a) => a.id === agent.id)) ?? agent;
  const { saving, change } = useAdminSwitch();
  return (
    <div className="agent-editor__label agent-admin-switch" role="group" aria-label="Admin">
      <span className="agent-admin-switch__row">
        <span>Admin — can manage and approve for other agents</span>
        <Toggle
          on={isAdmin(live)}
          label="Admin — can manage and approve for other agents"
          onChange={(on) => saving === null && void change(live, on)}
        />
      </span>
      <p className="agent-editor__hint">{ADMIN_DETAIL}</p>
    </div>
  );
}

export function AgentAdminSettings() {
  const agents = useAgentsSelector((s) => s.agents);
  const loaded = useAgentsSelector((s) => s.loaded);
  const { saving, change } = useAdminSwitch();
  const { showToast } = useOptionalToast();
  const [activity, setActivity] = useState<AdminActivity[] | null>(null);
  const [deleted, setDeleted] = useState<DeletedAgent[] | null>(null);
  const ref = useRef<HTMLElement>(null);

  // Re-read whenever the team changes (an admin deleted someone, a restore).
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    Promise.all([adminActivity(20), recentlyDeleted()])
      .then(([a, d]) => {
        if (!live) return;
        setActivity(a);
        setDeleted(d);
      })
      .catch((e: unknown) => showToast(formatCommandError(asCommandError(e)), 'error'));
    return () => {
      live = false;
    };
  }, [loaded, agents, showToast]);
  useEffect(() => {
    if (loaded && takeSettingsSectionRequest('agent-admins')) {
      ref.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [loaded]);
  if (!loaded) return null;

  const restore = async (d: DeletedAgent) => {
    try {
      await restoreAgent(d.id);
      showToast(`${d.name} is back`, 'success');
      // The team changes, so the lists above are read again.
      await refreshAgents();
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
    }
  };

  const team = agents.filter((a) => !a.hidden);
  return (
    <section
      className="settings-group agent-admin-settings"
      aria-labelledby="agents-settings-admins"
      ref={ref}
    >
      <h3 className="settings-group__title" id="agents-settings-admins">
        Admins
      </h3>
      <div className="settings-section">
        {team.map((a) => (
          <Row
            key={a.id}
            label={a.name}
            // Only an admin says so: the switch already says "off" for the rest,
            // and six rows of "Not an admin" buried the one that is.
            description={isAdmin(a) ? 'Manages and approves local work for the others' : undefined}
          >
            <Toggle
              on={isAdmin(a)}
              label={`${a.name}: admin`}
              onChange={(on) => saving === null && void change(a, on)}
            />
          </Row>
        ))}
        <p className="agent-admin-settings__note">
          Spending, sending, publishing, pushing, sharing and keys always come to you.
        </p>
      </div>

      <h4 className="agent-admin-settings__heading">Admin activity</h4>
      <div className="settings-section">
        {activity === null ? null : activity.length === 0 ? (
          <p className="agent-admin-settings__empty">
            Nothing yet. What an admin does for the others is listed here.
          </p>
        ) : (
          <ul className="agent-admin-activity">
            {activity.map((a, i) => (
              <li key={`${a.ts}-${i}`} className="agent-admin-activity__line">
                <span className="agent-admin-activity__who">{a.admin.name}</span>
                <span className="agent-admin-activity__what">{a.action}</span>
                <time className="agent-admin-activity__when">{when(a.ts)}</time>
              </li>
            ))}
          </ul>
        )}
      </div>

      {deleted && deleted.length > 0 && (
        <>
          <h4 className="agent-admin-settings__heading">Recently deleted</h4>
          <div className="settings-section">
            {deleted.map((d) => (
              <Row
                key={d.id}
                label={d.name}
                description={`${d.deletedBy ? `Deleted by ${d.deletedBy.name} · ` : ''}${restorableLine(d.restorableUntil)}`}
              >
                <Button variant="secondary" onClick={() => void restore(d)}>
                  Restore
                </Button>
              </Row>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * An admin's batch: each card answered for the agent that asked, read live
 * from that agent's chat once it has loaded.
 */
export function DecideCards({ message }: { message: AgentMessage }) {
  const items = message.decide ?? [];
  const { showToast } = useOptionalToast();
  const lines = useAgentsSelector((s) => s.messages);
  const loadedIds = items.map((d) => d.agentId).filter((id) => lines[id] !== undefined);
  const missing = [...new Set(items.map((d) => d.agentId))].filter((id) => !loadedIds.includes(id));
  useEffect(() => {
    for (const id of missing) void loadMessages(id);
    // Each asking agent's chat is read once, so its card is live here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing.join(',')]);
  if (items.length === 0) return null;
  return (
    <div className="agent-decide" role="group" aria-label="Only you can decide">
      {items.map((item) => {
        const live = lines[item.agentId]?.find(
          (m) => m.approval?.requestId === item.approval.requestId
        );
        const card: AgentMessage = live ?? {
          ...message,
          id: `${message.id}:${item.approval.requestId}`,
          agentId: item.agentId,
          kind: 'approval',
          text: '',
          approval: item.approval,
          decide: undefined,
        };
        return (
          <div key={item.approval.requestId} className="agent-decide__item">
            <span className="agent-decide__who">{item.agentName}</span>
            <ApprovalCard
              message={card}
              agentName={item.agentName}
              paused={false}
              compact
              onAnswer={async (requestId, allow, always, note, choice) => {
                try {
                  await answerApproval(item.agentId, requestId, allow, always, note, choice);
                  void loadMessages(item.agentId);
                } catch (e) {
                  showToast(formatCommandError(asCommandError(e)), 'error');
                }
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
