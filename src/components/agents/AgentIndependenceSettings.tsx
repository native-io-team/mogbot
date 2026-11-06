/**
 * Settings → Agents → Independence: how much every agent does on its own
 * (`agents::independence`). Read from the overview; ⌘K "How independent your
 * agents are…" scrolls here.
 *
 * @module components/agents/AgentIndependenceSettings
 */

import { useEffect, useRef, useState } from 'react';
import { IndependenceChoice } from './IndependenceChoice';
import { useAgentsSelector, refreshAgents } from '../../lib/agentsStore';
import {
  INDEPENDENCE_QUESTION,
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
  useEffect(() => {
    if (loaded && takeSettingsSectionRequest('agent-independence')) {
      ref.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [loaded]);
  if (!loaded) return null;

  const value = picked ?? independenceOf(saved);
  const choose = async (level: AgentIndependence) => {
    if (level === value) return;
    setPicked(level);
    setSaving(true);
    try {
      await setIndependence(level);
      await refreshAgents();
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
    } finally {
      setPicked(null);
      setSaving(false);
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
        Independence
      </h3>
      <div className="settings-section agent-independence-settings__body">
        <span className="agent-independence-settings__question">{INDEPENDENCE_QUESTION}</span>
        <IndependenceChoice value={value} onChange={(l) => void choose(l)} />
        {own > 0 && <p className="agent-independence-settings__own">{ownIndependenceLine(own)}</p>}
      </div>
    </section>
  );
}
