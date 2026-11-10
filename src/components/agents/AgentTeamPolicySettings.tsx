/**
 * Settings → Independence → What agents can reach: the team's defaults every
 * agent starts from (`agents/policy.rs`): projects, folders, apps, the
 * browser, rules, and "Reset everyone to the team's settings". Secondary to
 * chat: asking the Chief of Staff ("let Hiring work in the client site",
 * "lock everyone down") proposes the same changes on a card.
 *
 * No presets and no level here: independence is one scale, the slider above
 * this on the same page, so its line is left out rather than shown twice.
 * Agents with settings of their own keep them until the reset, which asks
 * first.
 *
 * @module components/agents/AgentTeamPolicySettings
 */

import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ErrorIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { ProjectActionConfirmModal } from '../dashboard/ProjectActionConfirmModal';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { refreshAgents } from '../../lib/agentsStore';
import { takeSettingsSectionRequest } from '../../lib/settings';
import {
  ENFORCED_NOTE,
  POLICY_EVENT,
  RESET_EVERYONE_LABEL,
  setPolicy,
  teamPolicy,
  type TeamPolicyView,
} from '../../lib/agentPolicy';

export function AgentTeamPolicySettings() {
  const load = useCallback(() => teamPolicy(), []);
  const { data: view, error: loadError, execute } = useAsyncState<TeamPolicyView>(load);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [ref, setRef] = useState<HTMLElement | null>(null);
  useEffect(() => {
    void execute();
    let off: (() => void) | undefined;
    void listen(POLICY_EVENT, () => void execute())
      .then((u) => (off = u))
      .catch(() => {});
    return () => off?.();
  }, [execute]);
  useEffect(() => {
    if (view && ref && takeSettingsSectionRequest('agent-policy')) {
      ref.scrollIntoView?.({ block: 'start' });
    }
  }, [view, ref]);

  const resetEveryone = async () => {
    setError(null);
    setBusy(true);
    try {
      await setPolicy({ kind: 'team', everyone: true }, { sameAsTeam: true });
      await execute();
      await refreshAgents();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setBusy(false);
      setResetting(false);
    }
  };

  if (!view) {
    return loadError ? (
      <p className="agent-editor__error" role="alert">
        <ErrorIcon size={12} className="inline-error-icon" />
        {formatCommandError(asCommandError(loadError))}
      </p>
    ) : null;
  }
  const own = view.ownSettings;
  // The level is the slider's, above on the same page.
  const lines = view.lines.filter((l) => l.key !== 'independence');

  return (
    <section
      className="settings-group agent-team-policy"
      aria-labelledby="agents-settings-policy"
      aria-busy={busy || undefined}
      ref={setRef}
    >
      <h3 className="settings-group__title" id="agents-settings-policy">
        What agents can reach
      </h3>
      <div className="settings-section agent-team-policy__body">
        <span className="agent-team-policy__lead">
          Every agent starts from these. To change one agent, or everyone, just ask your Chief of
          Staff in chat: it shows you the change on a card first.
        </span>
        <dl className="agent-team-policy__lines">
          {lines.map((l) => (
            <div key={l.key} className="agent-team-policy__line">
              <dt>{l.label}</dt>
              <dd>
                {l.value}
                {l.enforced === 'prompt' && (
                  <span className="agent-team-policy__meta"> · instructions</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
        <span className="agent-team-policy__lead">{ENFORCED_NOTE}</span>
        <div className="agent-team-policy__reset">
          <span className="agent-team-policy__lead">
            {own.length === 0
              ? 'Every agent uses these.'
              : `${own.length === 1 ? '1 agent has its' : `${own.length} agents have their`} own: ${own.join(', ')}.`}
          </span>
          {own.length > 0 && (
            <Button
              variant="secondary"
              size="compact"
              disabled={busy}
              onClick={() => setResetting(true)}
            >
              {RESET_EVERYONE_LABEL}
            </Button>
          )}
        </div>
        {error && (
          <p className="agent-editor__error" role="alert">
            <ErrorIcon size={12} className="inline-error-icon" />
            {error}
          </p>
        )}
      </div>
      {resetting && (
        <ProjectActionConfirmModal
          title={`${RESET_EVERYONE_LABEL}?`}
          body={
            <p>
              {own.join(', ')} {own.length === 1 ? 'loses its' : 'lose their'} own settings, level
              included, and {own.length === 1 ? 'goes' : 'go'} back to the team’s. Who’s an admin
              stays as it is.
            </p>
          }
          hint="It applies from each agent’s next message."
          loading={busy}
          confirmLabel="Reset everyone"
          loadingLabel="Resetting…"
          confirmVariant="primary"
          onCancel={() => setResetting(false)}
          onConfirm={() => void resetEveryone()}
        />
      )}
    </section>
  );
}
