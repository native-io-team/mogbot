/**
 * A form block: the few details an agent needs, asked once instead of over
 * five messages. Submitting sends the answers as the user's own message
 * (`formReply`: one "Label: value" line each), through the usual send.
 * Never a secret: the Mac refuses a form that asks for one, and secrets keep
 * their masked card.
 *
 * @module components/agents/blocks/BlockForm
 */

import { useId, useState, type FormEvent } from 'react';
import { Button } from '../../primitives/Button';
import { TextArea, TextField } from '../../primitives/TextField';
import { ToggleButton } from '../../primitives/ToggleButton';
import {
  badNumbers,
  formReply,
  missingFields,
  type FormBlock,
  type FormField,
  type FormValues,
} from '../../../../packages/companion-protocol/src/blocks';
import type { Answering } from './blockReply';

export function BlockForm({ block, answering }: { block: FormBlock; answering: Answering }) {
  const [values, setValues] = useState<FormValues>({});
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState(false);
  const base = useId();
  const answered = answering.answer != null || sent;
  const missing = missingFields(block, values);
  const bad = badNumbers(block, values);
  const off = !answering.reply || answered;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (off) return;
    setTried(true);
    if (missing.length || bad.length) return;
    answering.reply?.(formReply(block, values));
    if (!answering.staged) setSent(true);
  };
  const set = (id: string, v: string) => setValues((s) => ({ ...s, [id]: v }));
  const problem = (f: FormField) =>
    tried && missing.includes(f.id)
      ? 'Needed'
      : tried && bad.includes(f.id)
        ? 'A number, please'
        : null;
  return (
    <form
      className="agent-block-form"
      onSubmit={submit}
      noValidate
      aria-disabled={off || undefined}
    >
      {block.fields.map((f) => {
        const id = `${base}-${f.id}`;
        const err = problem(f);
        return (
          <div key={f.id} className="agent-block-form__field" data-type={f.type}>
            <label
              htmlFor={f.type === 'choice' ? undefined : id}
              id={`${id}-label`}
              className="agent-block-form__label"
            >
              {f.label}
              {!f.required && <span className="agent-block-form__optional">Optional</span>}
            </label>
            {f.type === 'choice' ? (
              <div
                className="agent-block-form__choices"
                role="radiogroup"
                aria-labelledby={`${id}-label`}
              >
                {(f.options ?? []).map((o) => (
                  <ToggleButton
                    key={o}
                    size="compact"
                    variant="secondary"
                    pressed={values[f.id] === o}
                    role="radio"
                    aria-checked={values[f.id] === o}
                    disabled={off}
                    onClick={() => set(f.id, values[f.id] === o ? '' : o)}
                  >
                    {o}
                  </ToggleButton>
                ))}
              </div>
            ) : f.type === 'long_text' ? (
              <TextArea
                id={id}
                rows={3}
                value={values[f.id] ?? ''}
                placeholder={f.placeholder}
                invalid={!!err}
                disabled={off}
                onChange={(e) => set(f.id, e.target.value)}
              />
            ) : (
              <TextField
                id={id}
                type={f.type === 'date' ? 'date' : 'text'}
                inputMode={f.type === 'number' ? 'decimal' : undefined}
                value={values[f.id] ?? ''}
                placeholder={f.placeholder}
                invalid={!!err}
                disabled={off}
                autoComplete="off"
                onChange={(e) => set(f.id, e.target.value)}
              />
            )}
            {err && (
              <span className="agent-block-form__error" role="alert">
                {err}
              </span>
            )}
          </div>
        );
      })}
      <div className="agent-block-form__actions">
        {answered ? (
          <span className="agent-block-form__done">Sent</span>
        ) : (
          <Button type="submit" variant="strong" disabled={off}>
            {block.submit}
          </Button>
        )}
      </div>
    </form>
  );
}
