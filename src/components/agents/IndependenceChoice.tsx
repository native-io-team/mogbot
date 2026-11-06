/**
 * How much agents do on their own: four choices, one line each, and one
 * honest line about what still asks at the chosen level. The same control in onboarding and
 * Settings → Agents (`AgentIndependenceSettings`); the phone words it from
 * the same strings.
 *
 * The selected choice is neutral (a stronger border), never the accent: it is
 * an answer, not an action.
 *
 * @module components/agents/IndependenceChoice
 */

import { useRef, type KeyboardEvent } from 'react';
import {
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_QUESTION,
  INDEPENDENCE_STILL_ASKS,
  type AgentIndependence,
} from '../../lib/agentIndependence';

export function IndependenceChoice({
  value,
  onChange,
  disabled = false,
  large = false,
}: {
  value: AgentIndependence;
  onChange: (level: AgentIndependence) => void;
  disabled?: boolean;
  /** Onboarding's roomier version. */
  large?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Arrow keys move between the choices, as a radio group does.
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const step =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + INDEPENDENCE_LEVELS.length) % INDEPENDENCE_LEVELS.length;
    refs.current[next]?.focus();
    onChange(INDEPENDENCE_LEVELS[next]);
  };

  return (
    <div className={`independence-choice${large ? ' independence-choice--large' : ''}`}>
      <div
        className="independence-choice__options"
        role="radiogroup"
        aria-label={INDEPENDENCE_QUESTION}
      >
        {INDEPENDENCE_LEVELS.map((level, i) => (
          <button
            key={level}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === level}
            tabIndex={value === level ? 0 : -1}
            disabled={disabled}
            data-level={level}
            className="independence-choice__option"
            onClick={() => onChange(level)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className="independence-choice__label">{INDEPENDENCE_LABEL[level]}</span>
            <span className="independence-choice__detail">{INDEPENDENCE_DETAIL[level]}</span>
          </button>
        ))}
      </div>
      <p className="independence-choice__always">{INDEPENDENCE_STILL_ASKS[value]}</p>
    </div>
  );
}
