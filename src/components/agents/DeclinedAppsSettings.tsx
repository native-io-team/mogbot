/**
 * Settings → Agents, "Apps you chose not to connect": every app declined
 * with "Not needed" or "Skip the rest" (`agents/declined.rs`), each with
 * "Turn back on", after which agents may ask for it again. Hidden when
 * nothing is declined.
 *
 * @module components/agents/DeclinedAppsSettings
 */

import { useState } from 'react';
import { Button } from '../primitives/Button';
import { ErrorIcon } from '@/components/icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { declinedApps, undeclineLogins, type DeclinedApp } from '../../lib/agentLogins';

export function DeclinedAppsSettings() {
  const { data, setData } = useAsyncState<DeclinedApp[]>(declinedApps, { immediate: true });
  const [error, setError] = useState<string | null>(null);
  if (!data || data.length === 0) return null;
  const turnBackOn = async (key: string) => {
    setError(null);
    try {
      await undeclineLogins([key]);
      setData(data.filter((d) => d.key !== key));
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    }
  };
  return (
    <section className="settings-group" aria-labelledby="agents-settings-declined">
      <h3 className="settings-group__title" id="agents-settings-declined">
        Apps you chose not to connect
      </h3>
      <div className="settings-section">
        {data.map((d) => (
          <div key={d.key} className="settings-row" data-declined={d.key}>
            <div className="settings-row-info">
              <span className="settings-row-label">{d.title}</span>
              <span className="settings-row-description">
                No agent asks for it. Turn it back on and they can ask again.
              </span>
            </div>
            <Button variant="secondary" onClick={() => void turnBackOn(d.key)}>
              Turn back on
            </Button>
          </div>
        ))}
        {error && (
          <p className="agent-editor__error" role="alert">
            <ErrorIcon size={12} className="inline-error-icon" />
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
