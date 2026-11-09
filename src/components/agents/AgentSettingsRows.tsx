/**
 * The toggle and the row Settings → Agents is made of.
 *
 * @module components/agents/AgentSettingsRows
 */

import type { ReactNode } from 'react';

export function Toggle({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`settings-toggle ${on ? 'on' : 'off'}`}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      aria-label={label}
    >
      <span className="settings-toggle-track">
        <span className="settings-toggle-thumb" />
      </span>
    </button>
  );
}

export function Row({
  label,
  description,
  children,
  stacked,
}: {
  label: string;
  description: string;
  children?: ReactNode;
  /** Actions under the words rather than beside them (several buttons). */
  stacked?: boolean;
}) {
  return (
    <div className={stacked ? 'settings-row settings-row--stacked' : 'settings-row'}>
      <div className="settings-row-info">
        <span className="settings-row-label">{label}</span>
        <span className="settings-row-description">{description}</span>
      </div>
      {children}
    </div>
  );
}
