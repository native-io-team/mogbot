/**
 * How an agent looks: its key's colourway, its legend and the keyboard key
 * it's bound to, with the key itself at full size (112px) changing as you
 * pick. Colours are a radio group with one Tab stop, the arrows moving focus
 * and the choice together, as radios do; the legend is searched from every
 * icon there is (`AgentKeyIconPicker`). Each choice is drawn as the key it
 * would make. The bound key is a press-to-bind field: a
 * letter or digit binds it, and one another agent has is refused with a line
 * saying whose (docs/internal/agent-keys.md).
 *
 * @module components/agents/AgentKeyPicker
 */

import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { COLORWAYS, normalizeBoundKey } from '../../../packages/companion-protocol/src/agentKeys';
import type { AgentIndependence } from '../../../packages/companion-protocol/src/model';
import { CheckIcon } from '@/components/icons';
import { AgentKey } from './AgentKey';
import { AgentKeyIconPicker } from './AgentKeyIconPicker';

export interface KeyTaken {
  key: string;
  name: string;
}

interface AgentKeyPickerProps {
  name: string;
  colorway: string;
  icon: string;
  boundKey: string | null;
  /** Its independence, for the preview's pips. */
  level: AgentIndependence | null;
  /** Keys the rest of the team is bound to. */
  taken: KeyTaken[];
  onColorwayChange: (colorway: string) => void;
  onIconChange: (icon: string) => void;
  onBoundKeyChange: (key: string) => void;
  /** Focus the icon search when it opens (opened by hand). */
  autoFocusSearch?: boolean;
}

/** Why a typed key can't be this agent's, or nothing. */
export function boundKeyProblem(typed: string, taken: KeyTaken[]): string | null {
  const key = normalizeBoundKey(typed);
  if (!key) return 'Pick one letter or digit.';
  const other = taken.find((t) => t.key === key);
  return other
    ? `${key} is already ${other.name}’s key. Pick another, or change theirs first.`
    : null;
}

export function AgentKeyPicker({
  name,
  colorway,
  icon,
  boundKey,
  level,
  taken,
  onColorwayChange,
  onIconChange,
  onBoundKeyChange,
  autoFocusSearch = false,
}: AgentKeyPickerProps) {
  return (
    <div className="agent-look">
      <div className="agent-look__preview">
        <AgentKey
          name={name}
          colorway={colorway}
          icon={icon}
          boundKey={boundKey}
          level={level}
          size="xl"
        />
      </div>
      <div className="agent-look__rows">
        <RadioRow
          label="Colour"
          values={COLORWAYS.map((c) => c.id)}
          value={colorway}
          onChange={onColorwayChange}
          name={(id) => COLORWAYS.find((c) => c.id === id)?.name ?? id}
          render={(id) => <AgentKey name={name} colorway={id} icon={icon} size="md" />}
        />
        <AgentKeyIconPicker
          name={name}
          colorway={colorway}
          icon={icon}
          onChange={onIconChange}
          autoFocus={autoFocusSearch}
        />
        <BindField boundKey={boundKey} taken={taken} onChange={onBoundKeyChange} />
      </div>
    </div>
  );
}

/**
 * Press-to-bind: focus it and press a key. Escape and Tab leave it as it
 * was; a key someone else has, or one that can't be bound, says why.
 */
function BindField({
  boundKey,
  taken,
  onChange,
}: {
  boundKey: string | null;
  taken: KeyTaken[];
  onChange: (key: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Tab') return;
    if (e.key === 'Escape') {
      if (listening) {
        e.preventDefault();
        e.stopPropagation();
        setListening(false);
      }
      return;
    }
    if (!listening) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setListening(true);
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    if (e.key.length !== 1) return;
    const why = boundKeyProblem(e.key, taken);
    setProblem(why);
    if (!why) {
      onChange(normalizeBoundKey(e.key) as string);
      setListening(false);
    }
  };
  return (
    <div className="agent-look__row">
      <span className="agent-look__label" id="agent-look-bind-label">
        Shortcut key
      </span>
      <div className="agent-look__bind">
        <button
          type="button"
          className="agent-look__bind-field"
          aria-labelledby="agent-look-bind-label"
          aria-describedby="agent-look-bind-hint"
          data-listening={listening || undefined}
          onClick={() => setListening(true)}
          onBlur={() => setListening(false)}
          onKeyDown={onKeyDown}
        >
          {listening ? 'Press a key…' : (boundKey ?? 'None')}
        </button>
        <span className="agent-look__hint" id="agent-look-bind-hint" role="status">
          {problem ?? `Press ${boundKey ?? 'it'} anywhere outside a text box to open this agent.`}
        </span>
      </div>
    </div>
  );
}

function RadioRow({
  label,
  values,
  value,
  onChange,
  name,
  render,
}: {
  label: string;
  values: readonly string[];
  value: string;
  onChange: (v: string) => void;
  name: (v: string) => string;
  render: (v: string) => ReactNode;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const at = Math.max(0, values.indexOf(value));
    const next = values[(at + step + values.length) % values.length];
    onChange(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
  };
  // An unknown value (a registry edited by hand) still leaves one Tab stop.
  const stop = values.includes(value) ? value : values[0];
  return (
    <div className="agent-look__row" role="group" aria-label={label}>
      <span className="agent-look__label">{label}</span>
      <div
        className="agent-look__choices"
        role="radiogroup"
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        {values.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            tabIndex={v === stop ? 0 : -1}
            aria-checked={v === value}
            aria-label={name(v)}
            title={name(v)}
            className="agent-look__choice"
            data-value={v}
            data-selected={v === value || undefined}
            onClick={() => onChange(v)}
          >
            {render(v)}
            {v === value && (
              <span className="agent-look__check" aria-hidden="true">
                <CheckIcon size={8} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
