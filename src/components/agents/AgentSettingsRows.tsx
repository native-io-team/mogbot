/**
 * The switch, the row and the group every Settings page is made of: the
 * agents' pages and the app's (Projects, Appearance, Advanced) alike, so the
 * window has one rhythm and one switch.
 *
 * @module components/agents/AgentSettingsRows
 */

import type { ReactNode } from 'react';

export function Toggle({
  on,
  label,
  onChange,
  disabled,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
  /** While the value is still being read: it can't be flipped yet. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`settings-toggle ${on ? 'on' : 'off'}`}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
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
  label: ReactNode;
  description: ReactNode;
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

/** A titled group of rows: its heading, its rows, a hairline before the next. */
export function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="settings-group" aria-labelledby={`settings-group-${id}`}>
      <h3 className="settings-group__title" id={`settings-group-${id}`}>
        {title}
      </h3>
      <div className="settings-section">{children}</div>
    </section>
  );
}
