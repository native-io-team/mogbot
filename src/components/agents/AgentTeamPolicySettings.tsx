/**
 * Settings → Agents → What agents can do: the team's defaults every agent
 * starts from (`agents/policy.rs`), the three presets, and "Reset everyone to
 * …". Secondary to chat: asking the Chief of Staff ("let Hiring work in the
 * client site", "lock everyone down") proposes the same changes on a card.
 *
 * Picking a preset changes the team's defaults; agents with settings of
 * their own keep them until "Reset everyone", which asks first.
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
  PRESET_LABEL,
  resetLabel,
  setPolicy,
  teamPolicy,
  type PolicyPreset,
  type TeamPolicyView,
} from '../../lib/agentPolicy';

export function AgentTeamPolicySettings() {
  const load = useCallback(() => teamPolicy(), []);
  const { data: view, error: loadError, execute } = useAsyncState<TeamPolicyView>(load);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState<PolicyPreset | null>(null);
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

  const run = async (everyone: boolean, preset: PolicyPreset) => {
    setError(null);
    setBusy(true);
    try {
      await setPolicy({ kind: 'team', everyone }, { preset });
      await execute();
      await refreshAgents();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setBusy(false);
      setResetting(null);
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
  const resetTo = view.preset ?? 'balanced';

  return (
    <section
      className="settings-group agent-team-policy"
      aria-labelledby="agents-settings-policy"
      aria-busy={busy || undefined}
      ref={setRef}
    >
      <h3 className="settings-group__title" id="agents-settings-policy">
        What agents can do
      </h3>
      <div className="settings-section agent-team-policy__body">
        <span className="agent-team-policy__lead">
          Every agent starts from these. To change one agent, or everyone, just ask your Chief of
          Staff in chat: it shows you the change on a card first.
        </span>
        <div className="agent-team-policy__presets" role="radiogroup" aria-label="Team defaults">
          {view.presets.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={view.preset === p.id}
              className="agent-team-policy__preset"
              disabled={busy}
              onClick={() => view.preset !== p.id && void run(false, p.id)}
            >
              <span className="agent-team-policy__preset-label">{p.label}</span>
              <span className="agent-team-policy__preset-detail">{p.blurb}</span>
            </button>
          ))}
        </div>
        {!view.preset && (
          <span className="agent-team-policy__lead">The team’s defaults are your own mix.</span>
        )}
        <dl className="agent-team-policy__lines">
          {view.lines.map((l) => (
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
              ? 'No agent has settings of its own.'
              : `${own.length === 1 ? '1 agent has' : `${own.length} agents have`} settings of ${own.length === 1 ? 'its' : 'their'} own: ${own.join(', ')}.`}
          </span>
          <Button
            variant="secondary"
            size="compact"
            disabled={busy}
            onClick={() => setResetting(resetTo)}
          >
            {resetLabel(resetTo)}
          </Button>
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
          title={`${resetLabel(resetting)}?`}
          body={
            <p>
              Every agent goes to {PRESET_LABEL[resetting]}
              {own.length > 0 ? `, and ${own.join(', ')} lose their own settings` : ''}. Who’s an
              admin stays as it is.
            </p>
          }
          hint="It applies from each agent’s next turn."
          loading={busy}
          confirmLabel="Reset everyone"
          loadingLabel="Resetting…"
          confirmVariant="primary"
          onCancel={() => setResetting(null)}
          onConfirm={() => void run(true, resetting)}
        />
      )}
    </section>
  );
}
