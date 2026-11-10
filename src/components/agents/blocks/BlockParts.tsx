/**
 * The smaller blocks: metric tiles, facts, a checklist, steps, a comparison,
 * quick replies, links, a callout, code. Each is text and numbers only; the
 * interactive ones answer through `Answering` (the user's own message).
 *
 * @module components/agents/blocks/BlockParts
 */

import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CloseIcon,
  ExternalLinkIcon,
  InfoIcon,
  PendingCircleIcon,
  SuccessIcon,
  WarningIcon,
} from '@/components/icons';
import { Button } from '../../primitives/Button';
import { useOptionalToast } from '../../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../../lib/errors';
import {
  chartModel,
  metricDelta,
  metricValue,
  pickedReply,
  type CalloutBlock,
  type ChecklistBlock,
  type ChoicesBlock,
  type CodeBlock,
  type ComparisonBlock,
  type FactsBlock,
  type LinksBlock,
  type Metric,
  type MetricsBlock,
  type StepsBlock,
} from '../../../../packages/companion-protocol/src/blocks';
import type { Answering } from './blockReply';

/* ---- Metrics ----------------------------------------------------------------- */

export function BlockMetrics({ block }: { block: MetricsBlock }) {
  return (
    <ul className="agent-block-metrics" data-count={Math.min(block.items.length, 4)}>
      {block.items.map((m, i) => (
        <MetricTile key={i} metric={m} />
      ))}
    </ul>
  );
}

function MetricTile({ metric }: { metric: Metric }) {
  const delta = metricDelta(metric);
  return (
    <li className="agent-block-metric">
      <span className="agent-block-metric__label">{metric.label}</span>
      <span className="agent-block-metric__value">{metricValue(metric)}</span>
      {(delta || metric.vs) && (
        <span className="agent-block-metric__delta" data-tone={delta?.tone}>
          {delta && delta.direction !== 'flat' && (
            <span className="agent-block-metric__arrow" aria-hidden>
              {delta.direction === 'up' ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
            </span>
          )}
          {delta && (
            <span>
              <span className="sr-only">
                {delta.direction === 'up' ? 'Up ' : delta.direction === 'down' ? 'Down ' : ''}
              </span>
              {delta.text}
            </span>
          )}
          {metric.vs && <span className="agent-block-metric__vs">{metric.vs}</span>}
        </span>
      )}
      {metric.trend && metric.trend.length > 1 && <Spark values={metric.trend} />}
    </li>
  );
}

function Spark({ values }: { values: number[] }) {
  const w = 120;
  const h = 28;
  const model = chartModel(
    { kind: 'chart', chart: 'sparkline', summary: '', labels: [], series: [{ name: '', values }] },
    w,
    h
  );
  if (model.type !== 'cartesian') return null;
  const line = model.lines[0];
  const last = line?.points.filter(Boolean).pop();
  return (
    <svg
      className="agent-block-metric__spark"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
    >
      {line && (
        <path
          d={line.line}
          className="agent-block-chart__line agent-block-metric__spark-line"
          data-spark
        />
      )}
      {last && <circle className="agent-block-metric__spark-dot" cx={last.x} cy={last.y} r={2.5} />}
    </svg>
  );
}

/* ---- Facts, checklist, steps ------------------------------------------------- */

export function BlockFacts({ block }: { block: FactsBlock }) {
  return (
    <dl className="agent-block-facts">
      {block.items.map((f, i) => (
        <div key={i} className="agent-block-facts__row">
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function BlockChecklist({ block }: { block: ChecklistBlock }) {
  const done = block.items.filter((i) => i.done).length;
  return (
    <div className="agent-block-checklist">
      <div
        className="agent-block-checklist__progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={block.items.length}
        aria-valuenow={done}
        aria-label={`${done} of ${block.items.length} done`}
      >
        <span style={{ width: `${(done / block.items.length) * 100}%` }} />
      </div>
      <span className="agent-block-checklist__count">
        {done} of {block.items.length} done
      </span>
      <ul>
        {block.items.map((it, i) => (
          <li key={i} data-done={it.done || undefined}>
            <span className="agent-block-checklist__box" aria-hidden>
              {it.done && <CheckIcon size={10} />}
            </span>
            <span className="agent-block-checklist__text">
              <span className="sr-only">{it.done ? 'Done: ' : 'Not done: '}</span>
              {it.text}
              {it.note && <span className="agent-block-checklist__note">{it.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STEP_WORD = {
  done: 'Done',
  current: 'In progress',
  todo: 'To do',
  failed: 'Failed',
} as const;

export function BlockSteps({ block }: { block: StepsBlock }) {
  return (
    <ol className="agent-block-steps">
      {block.items.map((s, i) => (
        <li
          key={i}
          data-status={s.status}
          aria-current={s.status === 'current' ? 'step' : undefined}
        >
          <span className="agent-block-steps__mark" aria-hidden>
            {s.status === 'done' ? (
              <CheckIcon size={10} />
            ) : s.status === 'failed' ? (
              <CloseIcon size={10} />
            ) : s.status === 'current' ? (
              <PendingCircleIcon size={12} />
            ) : (
              <span className="agent-block-steps__num">{i + 1}</span>
            )}
          </span>
          <span className="agent-block-steps__body">
            <span className="agent-block-steps__title">
              {s.title}
              <span className="sr-only"> ({STEP_WORD[s.status] ?? ''})</span>
            </span>
            {(s.detail || s.when || s.status === 'failed') && (
              <span className="agent-block-steps__detail">
                {[s.status === 'failed' ? 'Failed' : null, s.when, s.detail]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ---- Comparison and choices -------------------------------------------------- */

export function BlockComparison({
  block,
  answering,
}: {
  block: ComparisonBlock;
  answering: Answering;
}) {
  const picked = pickedReply(
    block.options.map((o) => o.reply),
    answering.answer
  );
  const answered = answering.answer != null;
  return (
    <div className="agent-block-compare" data-count={block.options.length}>
      {block.options.map((o, i) => (
        <section
          key={i}
          className="agent-block-compare__option"
          data-recommended={o.recommended || undefined}
          data-picked={picked === i || undefined}
          aria-label={o.name}
        >
          <header className="agent-block-compare__head">
            <h4>{o.name}</h4>
            {o.recommended && <span className="agent-block-compare__badge">Recommended</span>}
          </header>
          {o.summary && <p className="agent-block-compare__summary">{o.summary}</p>}
          {!!o.facts?.length && (
            <dl className="agent-block-compare__facts">
              {o.facts.map((f, k) => (
                <div key={k}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {(o.pros.length > 0 || o.cons.length > 0) && (
            <ul className="agent-block-compare__points">
              {o.pros.map((p, k) => (
                <li key={`p${k}`} data-kind="pro">
                  <span className="agent-block-compare__sign" aria-label="Pro">
                    +
                  </span>
                  {p}
                </li>
              ))}
              {o.cons.map((p, k) => (
                <li key={`c${k}`} data-kind="con">
                  <span className="agent-block-compare__sign" aria-label="Con">
                    −
                  </span>
                  {p}
                </li>
              ))}
            </ul>
          )}
          <div className="agent-block-compare__pick">
            {picked === i ? (
              <span className="agent-block-compare__chosen">
                <CheckIcon size={12} /> Your pick
              </span>
            ) : (
              answering.reply &&
              !answered && (
                <Button
                  variant={o.recommended ? 'strong' : 'secondary'}
                  width="fill"
                  onClick={() => answering.reply?.(o.reply)}
                >
                  Pick this
                </Button>
              )
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

export function BlockChoices({ block, answering }: { block: ChoicesBlock; answering: Answering }) {
  const [sent, setSent] = useState<number | null>(null);
  const answer = answering.answer;
  const fromAnswer = pickedReply(
    block.options.map((o) => o.reply),
    answer
  );
  const picked = fromAnswer >= 0 ? fromAnswer : sent;
  const answered = answer != null || sent != null;
  return (
    <div className="agent-block-choices">
      {block.question && <p className="agent-block-choices__question">{block.question}</p>}
      <div
        className="agent-block-choices__row"
        role="group"
        aria-label={block.question ?? 'Replies'}
      >
        {block.options.map((o, i) =>
          answered ? (
            picked === i && (
              <span key={i} className="agent-block-choices__picked">
                <CheckIcon size={12} />
                {o.label}
              </span>
            )
          ) : (
            <Button
              key={i}
              variant="secondary"
              disabled={!answering.reply}
              onClick={() => {
                answering.reply?.(o.reply);
                if (!answering.staged) setSent(i);
              }}
            >
              {o.label}
            </Button>
          )
        )}
        {answered && picked == null && (
          <span className="agent-block-choices__picked">Answered</span>
        )}
      </div>
    </div>
  );
}

/* ---- Links, callout, code ---------------------------------------------------- */

export function BlockLinks({ block }: { block: LinksBlock }) {
  const { showToast } = useOptionalToast();
  const open = (url: string) =>
    Promise.resolve()
      .then(() => openUrl(url))
      .catch((error: unknown) => showToast(formatCommandError(asCommandError(error)), 'error'));
  return (
    <ul className="agent-block-links">
      {block.items.map((l, i) => (
        <li key={i}>
          <button
            type="button"
            className="agent-block-link"
            onClick={() => void open(l.url)}
            title={l.url}
          >
            <span className="agent-block-link__glyph" aria-hidden>
              {l.domain.slice(0, 1).toUpperCase()}
            </span>
            <span className="agent-block-link__text">
              <span className="agent-block-link__label">{l.label}</span>
              <span className="agent-block-link__meta">
                {l.label === l.domain ? l.url.replace(/^https?:\/\//, '') : l.domain}
                {l.note ? ` · ${l.note}` : ''}
              </span>
            </span>
            <ExternalLinkIcon size={12} className="agent-block-link__out" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

const TONE = {
  info: { icon: InfoIcon, word: 'Note' },
  warning: { icon: WarningIcon, word: 'Heads up' },
  success: { icon: SuccessIcon, word: 'Done' },
} as const;

export function BlockCallout({ block }: { block: CalloutBlock }) {
  const tone = TONE[block.tone] ?? TONE.info;
  const Icon = tone.icon;
  return (
    <div
      className="agent-block-callout"
      data-tone={block.tone}
      role={block.tone === 'warning' ? 'note' : undefined}
    >
      <span className="agent-block-callout__icon" aria-hidden>
        <Icon size={14} />
      </span>
      <div className="agent-block-callout__body">
        <span className="agent-block-callout__title">{block.title ?? tone.word}</span>
        <p>{block.text}</p>
      </div>
    </div>
  );
}

export function BlockCode({ block }: { block: CodeBlock }) {
  const diff = block.language?.toLowerCase() === 'diff';
  const lines = block.code.replace(/\n$/, '').split('\n');
  return (
    <div className="agent-block-code" data-diff={diff || undefined}>
      {(block.language || block.title) && (
        <div className="agent-block-code__head">
          <span>{block.title ?? ''}</span>
          {block.language && <span className="agent-block-code__lang">{block.language}</span>}
        </div>
      )}
      <pre tabIndex={0}>
        <code>
          {diff
            ? lines.map((l, i) => (
                <span
                  key={i}
                  className="agent-block-code__line"
                  data-change={
                    l.startsWith('+') && !l.startsWith('+++')
                      ? 'add'
                      : l.startsWith('-') && !l.startsWith('---')
                        ? 'remove'
                        : l.startsWith('@@')
                          ? 'hunk'
                          : undefined
                  }
                >
                  {l || ' '}
                  {'\n'}
                </span>
              ))
            : block.code}
        </code>
      </pre>
    </div>
  );
}
