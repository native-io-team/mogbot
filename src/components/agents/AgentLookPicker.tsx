/**
 * How an agent looks: its shape, its face, its finish (a key cap or
 * embossed) and its colour, with the avatar itself, large, changing as you
 * pick. Each row is one radio group with one Tab stop; the arrows move focus
 * and the choice together, as radios do. The choices are drawn with the
 * current pick's other parts, so what a button shows is what you'd get, and
 * they hold still.
 *
 * @module components/agents/AgentLookPicker
 */

import type { KeyboardEvent, ReactNode } from 'react';
import {
  AVATAR_FACES,
  AVATAR_FINISHES,
  AVATAR_SHAPES,
  FACE_NAMES,
  FINISH_NAMES,
  SHAPE_NAMES,
  type AgentLook,
} from '../../../packages/companion-protocol/src/avatar';
import { AGENT_COLORS } from '../../lib/agents';
import { AgentAvatar } from './AgentAvatar';

const COLOR_NAMES: Record<string, string> = {
  white: 'White',
  brown: 'Brown',
  red: 'Red',
  orange: 'Orange',
  amber: 'Amber',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  gray: 'Gray',
};

interface AgentLookPickerProps {
  name: string;
  color: string;
  look: AgentLook;
  onLookChange: (look: AgentLook) => void;
  onColorChange: (color: string) => void;
}

export function AgentLookPicker({
  name,
  color,
  look,
  onLookChange,
  onColorChange,
}: AgentLookPickerProps) {
  return (
    <div className="agent-look">
      <div className="agent-look__preview" data-color={color}>
        <AgentAvatar name={name} color={color} look={look} size="xl" />
      </div>
      <div className="agent-look__rows">
        <RadioRow
          label="Shape"
          values={AVATAR_SHAPES}
          value={look.shape}
          onChange={(shape) => onLookChange({ ...look, shape })}
          name={(s) => SHAPE_NAMES[s]}
          render={(shape) => (
            <AgentAvatar name={name} color={color} look={{ ...look, shape }} size="field" still />
          )}
        />
        <RadioRow
          label="Face"
          values={AVATAR_FACES}
          value={look.face}
          onChange={(face) => onLookChange({ ...look, face })}
          name={(f) => FACE_NAMES[f]}
          render={(face) => (
            <AgentAvatar name={name} color={color} look={{ ...look, face }} size="field" still />
          )}
        />
        <RadioRow
          label="Finish"
          values={AVATAR_FINISHES}
          value={look.finish ?? 'keycap'}
          onChange={(finish) => onLookChange({ ...look, finish })}
          name={(f) => FINISH_NAMES[f]}
          render={(finish) => (
            <AgentAvatar name={name} color={color} look={{ ...look, finish }} size="field" still />
          )}
        />
        <RadioRow
          label="Color"
          values={AGENT_COLORS}
          // An unknown key (a registry edited by hand) still leaves one Tab stop.
          value={(AGENT_COLORS as readonly string[]).includes(color) ? color : AGENT_COLORS[0]}
          checked={(key) => key === color}
          onChange={onColorChange}
          name={(c) => COLOR_NAMES[c] ?? c}
          render={(key) => <span className="agent-look__swatch" data-color={key} />}
        />
      </div>
    </div>
  );
}

function RadioRow<T extends string>({
  label,
  values,
  value,
  checked = (v) => v === value,
  onChange,
  name,
  render,
}: {
  label: string;
  values: readonly T[];
  value: T;
  checked?: (v: T) => boolean;
  onChange: (v: T) => void;
  name: (v: T) => string;
  render: (v: T) => ReactNode;
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
            tabIndex={v === value ? 0 : -1}
            aria-checked={checked(v)}
            aria-label={name(v)}
            title={name(v)}
            className="agent-look__choice"
            data-value={v}
            data-selected={checked(v) || undefined}
            onClick={() => onChange(v)}
          >
            {render(v)}
          </button>
        ))}
      </div>
    </div>
  );
}
