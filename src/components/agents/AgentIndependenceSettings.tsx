/**
 * Settings → Independence, the team's level: how much every agent does on its
 * own (`agents::independence`), on the one four-stop slider. Read from the
 * overview; ⌘K "Independence…" scrolls here.
 *
 * @module components/agents/AgentIndependenceSettings
 */

import { useEffect, useRef, useState } from 'react';
import { IndependenceSlider } from './IndependenceSlider';
import { useAgentsSelector, refreshAgents } from '../../lib/agentsStore';
import {
  independenceOf,
  ownIndependenceCount,
  ownIndependenceLine,
  setIndependence,
  type AgentIndependence,
} from '../../lib/agentIndependence';
import { takeSettingsSectionRequest } from '../../lib/settings';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';

export function AgentIndependenceSettings() {
  const { showToast } = useOptionalToast();
  const saved = useAgentsSelector((s) => s.independence);
  const loaded = useAgentsSelector((s) => s.loaded);
  // Agents with a level of their own (their editor, the phone, the Chief).
  const own = useAgentsSelector((s) => ownIndependenceCount(s.agents ?? []));
  // Shown at once on a click; the overview confirms it.
  const [picked, setPicked] = useState<AgentIndependence | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLElement>(null);
  // The latest choice: an earlier one finishing must not snap the slider back
  // while a later one (→ pressed twice) is still saving.
  const latest = useRef(0);
  useEffect(() => {
    if (loaded && takeSettingsSectionRequest('agent-independence')) {
      ref.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [loaded]);
  if (!loaded) return null;

  const value = picked ?? independenceOf(saved);
  const choose = async (level: AgentIndependence) => {
    if (level === value) return;
    const mine = ++latest.current;
    setPicked(level);
    setSaving(true);
    try {
      await setIndependence(level);
      if (mine === latest.current) await refreshAgents();
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
    } finally {
      if (mine === latest.current) {
        setPicked(null);
        setSaving(false);
      }
    }
  };

  return (
    <section
      className="settings-group agent-independence-settings"
      aria-labelledby="agents-settings-independence"
      aria-busy={saving || undefined}
      ref={ref}
    >
      <h3 className="settings-group__title" id="agents-settings-independence">
        Your team
      </h3>
      <div className="settings-section agent-independence-settings__body">
        <span className="settings-row-description">
          Every agent runs at this, unless it has a level of its own.
        </span>
        <IndependenceSlider value={value} onChange={(l) => void choose(l)} showTitle={false} />
        {own > 0 && <p className="agent-independence-settings__own">{ownIndependenceLine(own)}</p>}
      </div>
    </section>
  );
}
