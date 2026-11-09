/**
 * Independence, how much agents do on their own: the one control for it, a
 * four-stop slider titled "Independence", from "Asks a lot" (Careful) to
 * "Just does it" (Unleashed). Under it, the chosen stop's one line, then the
 * line true at every stop. The same control in Settings →
 * Independence (`AgentIndependenceSettings`) and an agent's editor
 * (`AgentLevelPicker`); the phone draws the same stops from the same strings
 * (`IndependenceSetting`).
 *
 * One `role="slider"` carries the value for the keyboard and screen readers
 * (arrows, Home/End, the stop's name and line as its value text). The stop
 * names under the track are click targets only. A drag previews the stop
 * under the pointer and commits once, on release.
 *
 * Neutral throughout, never the accent: the level is an answer, not an action.
 *
 * @module components/agents/IndependenceSlider
 */

import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  INDEPENDENCE_ALWAYS_ASKS,
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_ENDS,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_TITLE,
  independenceStep,
  independenceValueText,
  type AgentIndependence,
} from '../../lib/agentIndependence';

const LAST = INDEPENDENCE_LEVELS.length - 1;

/** Where stop `i` sits along the rail, as a fraction. */
const at = (i: number) => i / LAST;

/** How far a stop's name shifts back over its tick: the ends hug the edges, the rest centre. */
const anchor = (i: number) => (i === 0 ? 0 : i === LAST ? 100 : 50);

export function IndependenceSlider({
  value,
  onChange,
  disabled = false,
  showTitle = true,
}: {
  value: AgentIndependence;
  onChange: (level: AgentIndependence) => void;
  disabled?: boolean;
  /** Off where a heading already asks the question; still its accessible name. */
  showTitle?: boolean;
}) {
  const titleId = useId();
  const detailId = useId();
  const rail = useRef<HTMLDivElement>(null);
  // The stop under a drag, until it is let go.
  const [dragging, setDragging] = useState<AgentIndependence | null>(null);
  const shown = dragging ?? value;
  const index = INDEPENDENCE_LEVELS.indexOf(shown);

  const commit = (level: AgentIndependence) => {
    if (!disabled && level !== value) onChange(level);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    let next: AgentIndependence | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = independenceStep(value, 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = independenceStep(value, -1);
    else if (e.key === 'Home') next = INDEPENDENCE_LEVELS[0];
    else if (e.key === 'End') next = INDEPENDENCE_LEVELS[LAST];
    if (!next) return;
    e.preventDefault();
    commit(next);
  };

  const stopAt = (clientX: number): AgentIndependence => {
    const r = rail.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return value;
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return INDEPENDENCE_LEVELS[Math.round(f * LAST)];
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    (e.currentTarget as HTMLElement).focus();
    setDragging(stopAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) setDragging(stopAt(e.clientX));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const level = stopAt(e.clientX);
    setDragging(null);
    commit(level);
  };

  return (
    <div className="independence-slider" data-level={shown}>
      {showTitle && (
        <span id={titleId} className="independence-slider__title">
          {INDEPENDENCE_TITLE}
        </span>
      )}
      <div className="independence-slider__ends" aria-hidden="true">
        <span>{INDEPENDENCE_ENDS.low}</span>
        <span>{INDEPENDENCE_ENDS.high}</span>
      </div>
      <div
        className="independence-slider__control"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={showTitle ? titleId : undefined}
        aria-label={showTitle ? undefined : INDEPENDENCE_TITLE}
        aria-describedby={detailId}
        aria-valuemin={0}
        aria-valuemax={LAST}
        aria-valuenow={index}
        aria-valuetext={independenceValueText(shown)}
        aria-disabled={disabled || undefined}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragging(null)}
      >
        <div className="independence-slider__rail" ref={rail}>
          <span className="independence-slider__track" />
          <span className="independence-slider__fill" style={{ width: `${at(index) * 100}%` }} />
          {INDEPENDENCE_LEVELS.map((level, i) => (
            <span
              key={level}
              className="independence-slider__tick"
              data-reached={i <= index || undefined}
              style={{ left: `${at(i) * 100}%` }}
            />
          ))}
          <span className="independence-slider__thumb" style={{ left: `${at(index) * 100}%` }} />
        </div>
      </div>
      <div className="independence-slider__stops" aria-hidden="true">
        {INDEPENDENCE_LEVELS.map((level, i) => (
          <button
            key={level}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            data-level={level}
            data-selected={level === shown || undefined}
            className="independence-slider__stop"
            style={{ left: `${at(i) * 100}%`, transform: `translateX(-${anchor(i)}%)` }}
            onClick={() => commit(level)}
          >
            {INDEPENDENCE_LABEL[level]}
          </button>
        ))}
      </div>
      <p className="independence-slider__detail" id={detailId} aria-live="polite">
        {INDEPENDENCE_DETAIL[shown]}
      </p>
      <p className="independence-slider__always">{INDEPENDENCE_ALWAYS_ASKS}</p>
    </div>
  );
}
