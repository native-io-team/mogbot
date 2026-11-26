/**
 * A decision card: the question, then each option as a full-width row, one
 * under the other (label, an optional line on what it means, Recommended on
 * at most one), and "Other" to type your own answer. A row sends its reply
 * as your message; once answered the card shows only what you picked.
 *
 * With `questions` it is several decisions paged in one card
 * (`BlockQuestions`). `OptionRows` is the same rows for a form's choice
 * field, as radios.
 *
 * @module components/agents/blocks/BlockChoices
 */

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { CheckIcon } from '@/components/icons';
import { Button } from '../../primitives/Button';
import { TextArea } from '../../primitives/TextField';
import {
  pickedReply,
  type ChoiceOption,
  type ChoicesBlock,
} from '../../../../packages/companion-protocol/src/blocks';
import type { Answering } from './blockReply';
import { BlockQuestions } from './BlockQuestions';

export function BlockChoices({ block, answering }: { block: ChoicesBlock; answering: Answering }) {
  return block.questions?.length ? (
    <BlockQuestions questions={block.questions} answering={answering} />
  ) : (
    <OneChoice block={block} answering={answering} />
  );
}

function OneChoice({ block, answering }: { block: ChoicesBlock; answering: Answering }) {
  const [sent, setSent] = useState<string | null>(null);
  const [other, setOther] = useState<string | null>(null);
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const questionId = useId();
  const answer = answering.answer ?? sent;
  const picked = pickedReply(
    block.options.map((o) => o.reply),
    answer
  );
  const off = !answering.reply;

  const choose = (reply: string) => {
    if (!answering.reply || !reply.trim()) return;
    answering.reply(reply.trim());
    if (!answering.staged) setSent(reply.trim());
  };

  if (answer != null) {
    const option = picked >= 0 ? block.options[picked] : null;
    return (
      <div className="agent-block-choices" data-answered>
        {block.question && <p className="agent-block-choices__question">{block.question}</p>}
        <div className="agent-block-choices__answer">
          <CheckIcon size={14} />
          <span>{option ? option.label : answer}</span>
        </div>
      </div>
    );
  }

  const otherKeys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      choose(other ?? '');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOther(null);
    }
  };

  return (
    <div className="agent-block-choices">
      {block.question && (
        <p id={questionId} className="agent-block-choices__question">
          {block.question}
        </p>
      )}
      <div
        className="agent-choice-list"
        role="group"
        aria-labelledby={block.question ? questionId : undefined}
        aria-label={block.question ? undefined : 'Options'}
      >
        {block.options.map((o, i) => (
          <OptionRow key={i} index={i} option={o} disabled={off} onPick={() => choose(o.reply)} />
        ))}
        {other == null ? (
          <button
            type="button"
            className="agent-choice"
            data-other
            disabled={off}
            onClick={() => {
              setOther('');
              requestAnimationFrame(() => otherRef.current?.focus());
            }}
          >
            <span className="agent-choice__mark" aria-hidden>
              {block.options.length + 1}
            </span>
            <span className="agent-choice__text">
              <span className="agent-choice__label">Other</span>
              <span className="agent-choice__description">Type your own answer</span>
            </span>
          </button>
        ) : (
          <div className="agent-choice agent-choice--typing">
            <TextArea
              ref={otherRef}
              rows={2}
              value={other}
              placeholder="Your answer"
              aria-label="Your answer"
              onChange={(e) => setOther(e.target.value)}
              onKeyDown={otherKeys}
            />
            <div className="agent-choice__actions">
              <Button variant="ghost" onClick={() => setOther(null)}>
                Cancel
              </Button>
              <Button variant="strong" disabled={!other.trim()} onClick={() => choose(other)}>
                {answering.staged ? 'Add to message' : 'Send'}
              </Button>
            </div>
          </div>
        )}
      </div>
      {off && <p className="agent-block-choices__off">Answer this in the agent's own chat.</p>}
    </div>
  );
}

function OptionRow({
  index,
  option,
  disabled,
  onPick,
}: {
  index: number;
  option: ChoiceOption;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className="agent-choice"
      data-recommended={option.recommended || undefined}
      disabled={disabled}
      onClick={onPick}
    >
      <span className="agent-choice__mark" aria-hidden>
        {index + 1}
      </span>
      <span className="agent-choice__text">
        <span className="agent-choice__label">
          {option.label}
          {option.recommended && <span className="agent-choice__badge">Recommended</span>}
        </span>
        {option.description && (
          <span className="agent-choice__description">{option.description}</span>
        )}
      </span>
    </button>
  );
}

/** A form's choice field: the same rows, as radios; picking again clears it. */
export function OptionRows({
  options,
  value,
  disabled,
  labelledBy,
  onChange,
}: {
  options: string[];
  value: string | undefined;
  disabled: boolean;
  labelledBy: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="agent-choice-list" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((o) => {
        const on = value === o;
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={on}
            className="agent-choice"
            data-picked={on || undefined}
            disabled={disabled}
            onClick={() => onChange(on ? '' : o)}
          >
            <span className="agent-choice__radio" aria-hidden>
              {on && <CheckIcon size={12} />}
            </span>
            <span className="agent-choice__text">
              <span className="agent-choice__label">{o}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
