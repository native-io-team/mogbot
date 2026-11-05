/**
 * Settings → Appearance → Accent colour.
 *
 * The app's accent is the Chief of Staff's colour, so this edits the Chief's
 * registry colour rather than a separate preference — the two can never
 * disagree. Every window follows through the agents registry event
 * (`useAppAccent`), and the agent editor shows the same choice.
 *
 * Arrow keys preview: the selection moves and the app repaints at once, but
 * the registry is written only on Space/Enter, a click, or once the arrows
 * have rested — so arrowing across the palette is one write, not eleven.
 *
 * @module components/dashboard/AccentColorSetting
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon } from '@/components/icons';
import { useOptionalToast } from '../../contexts/ToastContext';
import { AGENT_COLORS, updateAgent, type AgentColor } from '../../lib/agents';
import { refreshAgents, useAgentsSelector } from '../../lib/agentsStore';
import {
  ACCENT_LABELS,
  accentScopeProps,
  accentVars,
  applyAccentVars,
  DEFAULT_ACCENT,
  isAccentKey,
} from '../../lib/accent';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useResolvedTheme } from '../../lib/theme';

const selectChief = (s: { agents: { id: string; isMain: boolean; color: string }[] }) =>
  s.agents.find((a) => a.isMain) ?? null;

/** How long the arrow keys must rest before a previewed colour is saved. */
export const ACCENT_COMMIT_DELAY_MS = 600;

export function AccentColorSetting() {
  const { showToast } = useOptionalToast();
  const chief = useAgentsSelector(selectChief);
  // The swatches are painted in the current theme's version of each colour.
  const theme = useResolvedTheme();
  // Shown immediately on click; the registry confirms it a moment later.
  const [pending, setPending] = useState<AgentColor | null>(null);
  // Moved to with the arrow keys and painted, but not saved yet.
  const [preview, setPreview] = useState<AgentColor | null>(null);
  const saved: AgentColor =
    pending ?? (chief && isAccentKey(chief.color) ? chief.color : DEFAULT_ACCENT);
  const current: AgentColor = preview ?? saved;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const choose = useCallback(
    async (key: AgentColor) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setPreview(null);
      if (!chief || key === saved) return;
      setPending(key);
      try {
        await updateAgent(chief.id, { color: key });
        await refreshAgents();
      } catch (err) {
        // The preview already painted it; put the saved colour back.
        applyAccentVars(accentVars(chief.color));
        showToast(formatCommandError(asCommandError(err)), 'error');
      } finally {
        setPending(null);
      }
    },
    [chief, saved, showToast]
  );

  const previewColor = (key: AgentColor) => {
    setPreview(key);
    applyAccentVars(accentVars(key));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void choose(key), ACCENT_COMMIT_DELAY_MS);
  };

  // Leaving Settings mid-preview saves what is on screen rather than
  // silently reverting a colour the user is looking at.
  const flush = useRef<() => void>(() => undefined);
  flush.current = () => {
    if (timer.current && preview) void choose(preview);
  };
  useEffect(() => () => flush.current(), []);

  return (
    <div className="settings-row settings-row--stacked">
      <div className="settings-row-info">
        <span className="settings-row-label">Accent color</span>
        <span className="settings-row-description">
          {chief
            ? "Your Chief of Staff's color, used across the app. Inside another agent's conversation, that agent's color takes over."
            : 'Available once your Chief of Staff has been set up.'}
        </span>
      </div>
      <div
        className="settings-accent-options"
        role="radiogroup"
        aria-label="Accent color"
        onKeyDown={(e) => {
          const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
          if (!step) return;
          e.preventDefault();
          const at = AGENT_COLORS.indexOf(current);
          const next = AGENT_COLORS[(at + step + AGENT_COLORS.length) % AGENT_COLORS.length];
          previewColor(next);
          e.currentTarget.querySelector<HTMLElement>(`[data-accent-scope="${next}"]`)?.focus();
        }}
      >
        {AGENT_COLORS.map((key) => {
          const selected = key === current;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={ACCENT_LABELS[key]}
              title={ACCENT_LABELS[key]}
              tabIndex={selected ? 0 : -1}
              disabled={!chief}
              className="settings-accent-swatch"
              {...accentScopeProps(key, theme)}
              onClick={() => void choose(key)}
            >
              {selected && <CheckIcon size={12} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
