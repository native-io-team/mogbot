/**
 * Settings → Agents → "Agents' browser": the switch (on by default), and
 * the one-time guided card for the two macOS permissions a Google sign-in
 * from the phone needs. Every line is read back from the Mac.
 *
 * @module components/agents/AgentsBrowserSettings
 */

import { useCallback, useEffect } from 'react';
import { Button } from '../primitives/Button';
import { Row, Toggle } from './AgentSettingsRows';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import {
  AGENTS_BROWSER_TITLE,
  agentsBrowserLine,
  getAgentsBrowserStatus,
  openAgentsBrowserPermission,
  PERMISSION_ROWS,
  permissionsLine,
  setAgentsBrowserEnabled,
  type AgentsBrowserPermission,
  type AgentsBrowserStatus,
} from '../../lib/agentsOwnBrowser';

type Act =
  | { kind: 'read' }
  | { kind: 'switch'; on: boolean }
  | { kind: 'permission'; which: AgentsBrowserPermission };

const act = (a: Act): Promise<AgentsBrowserStatus> => {
  switch (a.kind) {
    case 'switch':
      return setAgentsBrowserEnabled(a.on);
    case 'permission':
      return openAgentsBrowserPermission(a.which);
    default:
      return getAgentsBrowserStatus();
  }
};

export function AgentsBrowserSettings() {
  const { showToast } = useOptionalToast();
  const onError = useCallback((e: Error) => showToast(e.message, 'error'), [showToast]);
  const { data: status, execute } = useAsyncState<AgentsBrowserStatus, [Act]>(act, { onError });
  const run = useCallback((a: Act) => void execute(a).catch(() => {}), [execute]);

  useEffect(() => {
    run({ kind: 'read' });
    // Back from System Settings: read the permissions again.
    const onFocus = () => run({ kind: 'read' });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [run]);

  if (status && !status.compiled) return null;
  return (
    <section className="settings-group" aria-labelledby="agents-settings-browser">
      <h3 className="settings-group__title" id="agents-settings-browser">
        {AGENTS_BROWSER_TITLE}
      </h3>
      <div className="settings-section">
        <Row label={AGENTS_BROWSER_TITLE} description={agentsBrowserLine(status)}>
          <Toggle
            on={status?.enabled ?? true}
            label={AGENTS_BROWSER_TITLE}
            onChange={(on) => run({ kind: 'switch', on })}
          />
        </Row>
        {status?.enabled && (
          <div data-testid="agents-browser-permissions">
            <Row
              label="Signing in to Google from your phone"
              description={permissionsLine(status.permissions)}
            />
            {PERMISSION_ROWS.map((p) => {
              const granted =
                p.id === 'screen_recording'
                  ? status.permissions.screenRecording
                  : status.permissions.accessibility;
              return (
                <Row key={p.id} label={p.label} description={p.description}>
                  {granted ? (
                    <span className="settings-row-description">Allowed</span>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() => run({ kind: 'permission', which: p.id })}
                    >
                      Allow…
                    </Button>
                  )}
                </Row>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
