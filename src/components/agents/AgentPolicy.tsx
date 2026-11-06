/**
 * The agent editor's "What it can do": the agent's settings in one list
 * (`agents/policy.rs`), each line saying whether it's the team's or its own,
 * and which ones are only instructions. Secondary to chat: "Change in chat"
 * drafts the request for the Chief of Staff, who proposes it on a card.
 * The quick menus here apply at once, because the user is the one choosing.
 *
 * @module components/agents/AgentPolicy
 */

import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ChevronIcon, ErrorIcon } from '@/components/icons';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { TextButton } from '../primitives/TextButton';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  ENFORCED_NOTE,
  HOW_LABEL,
  POLICY_EVENT,
  PRESET_LABEL,
  agentPolicy,
  chatDraft,
  setPolicy,
  type AgentPolicyView,
  type PolicyChange,
  type PolicyLine,
  type PolicyPreset,
  type ProjectHow,
} from '../../lib/agentPolicy';
import { INDEPENDENCE_LABEL, INDEPENDENCE_LEVELS } from '../../lib/agentIndependence';
import type { Agent } from '../../lib/agents';

const PRESETS: PolicyPreset[] = ['trusted', 'balanced', 'locked'];

/** The quick menu each line offers, when it has one. */
function lineMenu(
  line: PolicyLine,
  view: AgentPolicyView
): { label: string; change: PolicyChange; active: boolean }[] {
  const e = view.effective;
  switch (line.key) {
    case 'projects':
      return (['copy', 'direct', 'read_only'] as ProjectHow[]).map((how) => ({
        label: `${HOW_LABEL[how]} where it's set to work`,
        change: { how },
        active: e.projects.how === how,
      }));
    case 'apps':
      return [
        {
          label: 'Every app you’ve connected',
          change: { apps: 'all' },
          active: e.apps.mode === 'all',
        },
        { label: 'No apps', change: { apps: 'none' }, active: e.apps.mode === 'none' },
      ];
    case 'browser':
      return [
        { label: 'Can use your browser', change: { browser: true }, active: e.browser },
        { label: 'No browser', change: { browser: false }, active: !e.browser },
      ];
    case 'independence':
      return [
        {
          label: 'Same as the team',
          change: { independence: 'team' },
          active: !e.own.includes('independence'),
        },
        ...INDEPENDENCE_LEVELS.map((level) => ({
          label: INDEPENDENCE_LABEL[level],
          change: { independence: level } as PolicyChange,
          active: e.own.includes('independence') && e.independence === level,
        })),
      ];
    default:
      return [];
  }
}

/** Its own rules and folders, each one menu item away from coming off. */
function removable(
  key: PolicyLine['key'],
  view: AgentPolicyView
): { label: string; change: PolicyChange }[] {
  const e = view.effective;
  if (key === 'rules')
    return e.ownRules.map((r) => ({ label: `“${r}”`, change: { removeRules: [r] } }));
  if (key === 'folders' && e.own.includes('folders'))
    return e.folders.map((f) => ({ label: f.path, change: { removeFolders: [f.path] } }));
  return [];
}

export function AgentPolicy({
  agent,
  onAskInChat,
}: {
  agent: Agent;
  /** Draft a request in the Chief's chat (nothing is sent). */
  onAskInChat?: (text: string) => void;
}) {
  const load = useCallback(() => agentPolicy(agent.id), [agent.id]);
  const { data: view, error: loadError, execute } = useAsyncState<AgentPolicyView>(load);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void execute();
    let off: (() => void) | undefined;
    void listen(POLICY_EVENT, () => void execute())
      .then((u) => (off = u))
      .catch(() => {});
    return () => off?.();
  }, [execute]);

  const change = async (c: PolicyChange) => {
    setError(null);
    setBusy(true);
    try {
      await setPolicy({ kind: 'agent', agentId: agent.id }, c);
      await execute();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setBusy(false);
    }
  };

  const current = view?.sameAsTeam
    ? 'Same as the team'
    : view?.preset
      ? PRESET_LABEL[view.preset]
      : 'Its own settings';

  return (
    <div className="agent-editor__label agent-policy" role="group" aria-label="What it can do">
      <span className="agent-policy__head">
        What it can do
        {view && (
          <Dropdown
            align="right"
            portal
            trigger={(p) => (
              <MenuButton
                {...p}
                expanded={p['aria-expanded']}
                variant="secondary"
                size="compact"
                disabled={busy}
                rightIcon={
                  <ChevronIcon
                    size={10}
                    className={p['aria-expanded'] ? 'chevron-flipped' : undefined}
                  />
                }
              >
                {current}
              </MenuButton>
            )}
          >
            <DropdownItem
              active={view.sameAsTeam}
              onSelect={() => void change({ sameAsTeam: true })}
            >
              Same as the team
            </DropdownItem>
            <DropdownDivider />
            {PRESETS.map((p) => (
              <DropdownItem
                key={p}
                active={!view.sameAsTeam && view.preset === p}
                onSelect={() => void change({ preset: p })}
              >
                {PRESET_LABEL[p]}
              </DropdownItem>
            ))}
          </Dropdown>
        )}
      </span>
      {loadError && !view && (
        <p className="agent-editor__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {formatCommandError(asCommandError(loadError))}
        </p>
      )}
      {view && (
        <ul className="agent-policy__lines">
          {view.lines.map((line) => {
            const menu = lineMenu(line, view);
            return (
              <li key={line.key} className="agent-policy__line" data-key={line.key}>
                <span className="agent-policy__label">{line.label}</span>
                <span className="agent-policy__value">
                  {line.value}
                  <span className="agent-policy__meta">
                    {line.team ? 'Team default' : 'Its own'}
                    {line.enforced === 'prompt' ? ' · instructions' : ''}
                  </span>
                </span>
                {menu.length > 0 && (
                  <Dropdown
                    align="right"
                    portal
                    trigger={(p) => (
                      <TextButton
                        {...p}
                        tabIndex={0}
                        disabled={busy}
                        aria-label={`Change ${line.label}`}
                      >
                        Change
                      </TextButton>
                    )}
                  >
                    {menu.map((m) => (
                      <DropdownItem
                        key={m.label}
                        active={m.active}
                        onSelect={() => void change(m.change)}
                      >
                        {m.label}
                      </DropdownItem>
                    ))}
                  </Dropdown>
                )}
                {removable(line.key, view).length > 0 && (
                  <Dropdown
                    align="right"
                    portal
                    trigger={(p) => (
                      <TextButton
                        {...p}
                        tabIndex={0}
                        disabled={busy}
                        aria-label={`Remove from ${line.label}`}
                      >
                        Remove…
                      </TextButton>
                    )}
                  >
                    {removable(line.key, view).map((r) => (
                      <DropdownItem key={r.label} onSelect={() => void change(r.change)}>
                        {r.label}
                      </DropdownItem>
                    ))}
                  </Dropdown>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="agent-editor__hint">
        {ENFORCED_NOTE}{' '}
        {onAskInChat && (
          <TextButton tabIndex={0} onClick={() => onAskInChat(chatDraft(agent.name))}>
            Change in chat
          </TextButton>
        )}
      </p>
      {error && (
        <p className="agent-editor__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {error}
        </p>
      )}
    </div>
  );
}
