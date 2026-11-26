/**
 * Several decisions in one card, one page each, as Claude Code asks them: a
 * chip per question along the top ("Host", "Extras"… with a tick once
 * answered) and "2 of 3"; the question; its options as rows (radios, or
 * checkboxes when any number can be picked) and Other to type your own.
 * A single pick moves on to the next page; Back, Skip and Next move by hand;
 * the last page's Submit (or ⌘↵ anywhere in the card) sends every answer as
 * one message, a line per question (`questionsAnswer`).
 *
 * @module components/agents/blocks/BlockQuestions
 */

import { useRef, useState, type KeyboardEvent } from 'react';
import { CheckIcon } from '@/components/icons';
import { Button } from '../../primitives/Button';
import { TextArea } from '../../primitives/TextField';
import {
  questionsAnswer,
  type ChoiceQuestion,
} from '../../../../packages/companion-protocol/src/blocks';
import type { Answering } from './blockReply';

interface Pick {
  labels: string[];
  /** Typed under Other; null while Other is closed. */
  other: string | null;
}

const EMPTY: Pick = { labels: [], other: null };

const answersOf = (p: Pick) => {
  const typed = p.other?.trim();
  return typed ? [...p.labels, typed] : p.labels;
};

export function BlockQuestions({
  questions,
  answering,
}: {
  questions: ChoiceQuestion[];
  answering: Answering;
}) {
  const [page, setPage] = useState(0);
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(() => EMPTY));
  const [sent, setSent] = useState<string | null>(null);
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const answer = answering.answer ?? sent;
  const off = !answering.reply;
  const many = questions.length > 1;
  const last = page === questions.length - 1;
  const q = questions[page];
  const pick = picks[page] ?? EMPTY;
  const answered = picks.map((p) => answersOf(p).length > 0);
  const anyAnswered = answered.some(Boolean);

  if (answer != null) {
    return (
      <div className="agent-block-choices" data-answered>
        <ul className="agent-questions__answer">
          {answer.split('\n').map((line, i) => (
            <li key={i}>
              <CheckIcon size={14} />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const setPick = (next: Pick) => setPicks((list) => list.map((p, i) => (i === page ? next : p)));

  const go = (to: number) => setPage(Math.max(0, Math.min(questions.length - 1, to)));

  const submit = (list = picks) => {
    if (!answering.reply) return;
    const text = questionsAnswer(questions, list.map(answersOf));
    if (!text.trim()) return;
    answering.reply(text);
    if (!answering.staged) setSent(text);
  };

  const choose = (label: string) => {
    if (q.multi) {
      const on = pick.labels.includes(label);
      setPick({
        ...pick,
        labels: on ? pick.labels.filter((l) => l !== label) : [...pick.labels, label],
      });
      return;
    }
    const next = { labels: [label], other: null };
    setPick(next);
    // One pick answers this page: on to the next unanswered one, or done.
    if (!last) go(page + 1);
  };

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && anyAnswered) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="agent-block-choices agent-questions" onKeyDown={keys}>
      {many && (
        <div className="agent-questions__head">
          <ol className="agent-questions__chips" aria-label="Questions">
            {questions.map((item, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="agent-questions__chip"
                  aria-current={i === page ? 'step' : undefined}
                  data-answered={answered[i] || undefined}
                  disabled={off}
                  onClick={() => go(i)}
                >
                  {answered[i] && <CheckIcon size={12} />}
                  {item.header?.trim() || `Question ${i + 1}`}
                </button>
              </li>
            ))}
          </ol>
          <span className="agent-questions__count">
            {page + 1} of {questions.length}
          </span>
        </div>
      )}
      <p id={`q-${page}`} className="agent-block-choices__question">
        {q.question}
        {q.multi && <span className="agent-questions__hint"> Pick any.</span>}
      </p>
      <div
        className="agent-choice-list"
        role={q.multi ? 'group' : 'radiogroup'}
        aria-labelledby={`q-${page}`}
      >
        {q.options.map((o) => {
          const on = pick.labels.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              role={q.multi ? 'checkbox' : 'radio'}
              aria-checked={on}
              className="agent-choice"
              data-picked={on || undefined}
              data-recommended={o.recommended || undefined}
              disabled={off}
              onClick={() => choose(o.label)}
            >
              <span className={q.multi ? 'agent-choice__box' : 'agent-choice__radio'} aria-hidden>
                {on && <CheckIcon size={12} />}
              </span>
              <span className="agent-choice__text">
                <span className="agent-choice__label">
                  {o.label}
                  {o.recommended && <span className="agent-choice__badge">Recommended</span>}
                </span>
                {o.description && (
                  <span className="agent-choice__description">{o.description}</span>
                )}
              </span>
            </button>
          );
        })}
        {pick.other == null ? (
          <button
            type="button"
            className="agent-choice"
            data-other
            disabled={off}
            onClick={() => {
              setPick({ labels: q.multi ? pick.labels : [], other: '' });
              requestAnimationFrame(() => otherRef.current?.focus());
            }}
          >
            <span className={q.multi ? 'agent-choice__box' : 'agent-choice__radio'} aria-hidden />
            <span className="agent-choice__text">
              <span className="agent-choice__label">Other</span>
              <span className="agent-choice__description">Type your own answer</span>
            </span>
          </button>
        ) : (
          <div className="agent-choice agent-choice--typing" data-picked>
            <TextArea
              ref={otherRef}
              rows={2}
              value={pick.other}
              placeholder="Your answer"
              aria-label="Your answer"
              onChange={(e) => setPick({ ...pick, other: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setPick({ ...pick, other: null });
                } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  if (last) submit();
                  else go(page + 1);
                }
              }}
            />
          </div>
        )}
      </div>
      <div className="agent-questions__foot">
        {many && page > 0 && (
          <Button variant="ghost" disabled={off} onClick={() => go(page - 1)}>
            Back
          </Button>
        )}
        <span className="agent-questions__spacer" />
        {many && !last && (
          <Button
            variant="ghost"
            disabled={off}
            onClick={() => {
              setPick(EMPTY);
              go(page + 1);
            }}
          >
            Skip
          </Button>
        )}
        {last ? (
          <Button
            variant="strong"
            disabled={off || !anyAnswered}
            title="Submit (⌘↵)"
            onClick={() => submit()}
          >
            {answering.staged ? 'Add to message' : 'Submit'}
          </Button>
        ) : (
          <Button variant="secondary" disabled={off} onClick={() => go(page + 1)}>
            Next
          </Button>
        )}
      </div>
      {off && <p className="agent-block-choices__off">Answer this in the agent's own chat.</p>}
    </div>
  );
}
