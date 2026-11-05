/**
 * The pieces both import paths are built from: the numbered steps (the same
 * rail as Remote access setup), the message to send with its Copy button, the
 * preview of what a pasted reply brings, and the moment it's done.
 *
 * @module components/agents/ImportParts
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, ChevronRightIcon, CopyIcon, InfoIcon, WarningIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useAgentsList } from '../../lib/agentsStore';
import type { ImportSummary, PasteImportAgent, PasteImportPreview } from '../../lib/agents';
import { AgentAvatar } from './AgentAvatar';

export const plural = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** "and"-joined, the way a person lists names: "A", "A and B", "A, B and C". */
export const listOf = (names: string[]) =>
  names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export type StepState = 'todo' | 'current' | 'done';

interface ImportStepProps {
  n: number;
  state: StepState;
  title: string;
  /** Beside the title once the step is done and folded away. */
  aside?: ReactNode;
  /** Shown while the step isn't folded. */
  children?: ReactNode;
  folded?: boolean;
}

export function ImportStep({ n, state, title, aside, children, folded }: ImportStepProps) {
  return (
    <li className="agents-import-step" data-state={state}>
      <div className="agents-import-step__head">
        <span className="agents-import-step__marker" aria-hidden>
          {state === 'done' ? <CheckIcon size={12} /> : n}
        </span>
        <span className="agents-import-step__title">{title}</span>
        {aside && <span className="agents-import-step__aside">{aside}</span>}
      </div>
      {!folded && children && <div className="agents-import-step__body">{children}</div>}
    </li>
  );
}

/**
 * The message to send the other assistant, and the one action that matters
 * on this step. `onCopied` lets the caller tick the step.
 */
export function MessageCard({
  message,
  onCopied,
  lead = true,
  autoFocus = false,
}: {
  message: string;
  onCopied?: () => void;
  /** Primary until the user has moved past this step. */
  lead?: boolean;
  /** Take focus on open, so Enter copies: this is the first thing to do. */
  autoFocus?: boolean;
}) {
  const { copy, isCopied } = useCopyToClipboard({ onCopy: onCopied });
  const button = useRef<HTMLButtonElement>(null);
  // The message loads after the dialog opens, so the button is still disabled
  // when the dialog places focus. Take it once there's something to copy.
  const ready = !!message;
  useEffect(() => {
    if (autoFocus && lead && ready) button.current?.focus();
    // Only on arrival: never pull focus back once the user has moved on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  return (
    <div className="agents-import-message">
      <div className="agents-import-message__box">
        <blockquote className="agents-import-message__text" tabIndex={0}>
          {message}
        </blockquote>
      </div>
      <div className="agents-import-message__actions">
        <Button
          variant={lead ? 'primary' : 'secondary'}
          leftIcon={isCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          onClick={() => void copy(message)}
          disabled={!message}
          data-copied={isCopied || undefined}
          ref={button}
          className="agents-import-message__copy"
        >
          {isCopied ? 'Copied' : 'Copy message'}
        </Button>
        <span className="agents-import-message__hint" aria-live="polite">
          {isCopied
            ? 'Now paste it into a chat with your assistant.'
            : 'Grok Bot, Muse or any other assistant.'}
        </span>
      </div>
    </div>
  );
}

export type ImportChipKind = 'new' | 'main' | 'update' | 'skip' | 'taken' | 'replace';

/**
 * One agent an import would bring, wherever an import is reviewed (pasted,
 * from the other app here, or proposed by another assistant over the
 * connector): avatar, name and its chip, role, counts, and the detail one
 * click down under the same section labels. Chips are neutral; only words
 * tell them apart.
 */
export function ImportAgentRow({
  name,
  avatarName,
  color,
  chip,
  role,
  counts,
  away,
  select,
  inline,
  detail,
}: {
  name: string;
  /** Whose badge it wears (the main one wears the Chief's). */
  avatarName?: string;
  color: string;
  chip?: { kind: ImportChipKind; label: string };
  role?: string;
  counts?: ReactNode;
  /** Present but not coming: quieter. */
  away?: boolean;
  /** Ticked to import (the connector's review): the box before the row. */
  select?: { checked: boolean; disabled?: boolean; label: string; onChange: (v: boolean) => void };
  /** Always in view under the row (the instructions it would run). */
  inline?: ReactNode;
  /** What opening the row shows; rendered only when open. */
  detail: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li
      className="agents-import-agent"
      data-open={open || undefined}
      data-away={away || (select && !select.checked) || undefined}
    >
      <div className="agents-import-agent__line">
        {select && (
          <Checkbox
            checked={select.checked}
            disabled={select.disabled}
            onChange={select.onChange}
            label={select.label}
            className="agents-import-agent__check"
          />
        )}
        {/* A large disclosure surface, not an action: a raw button by design. */}
        <button
          type="button"
          className="agents-import-agent__row"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <AgentAvatar name={avatarName ?? name} color={color} />
          <span className="agents-import-agent__text">
            <span className="agents-import-agent__name">
              <span className="agents-import-agent__name-text">{name}</span>
              {chip && (
                <span className="agents-import-chip" data-kind={chip.kind}>
                  {chip.label}
                </span>
              )}
            </span>
            {role && <span className="agents-import-agent__role">{role}</span>}
            {counts && <span className="agents-import-agent__counts">{counts}</span>}
          </span>
          <ChevronRightIcon size={12} className="agents-import-agent__chevron" />
        </button>
      </div>
      {inline && <div className="agents-import-agent__inline">{inline}</div>}
      <div className="agents-import-agent__reveal">
        <div>{open && <div className="agents-import-agent__detail">{detail()}</div>}</div>
      </div>
    </li>
  );
}

/** One labelled part of an agent's detail: the same labels on every import. */
export function ImportSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function counts(agent: PasteImportAgent) {
  return [
    // Whether it brings instructions is the point; how many characters isn't.
    agent.instructionsChars ? 'Instructions' : 'No instructions',
    agent.memoryLines
      ? `${agent.memoryLines.toLocaleString()} ${agent.memoryLines === 1 ? 'memory' : 'memories'}`
      : 'no memory',
    agent.routines.length ? plural(agent.routines.length, 'routine') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function chipFor(
  agent: PasteImportAgent,
  mainName: string
): { kind: ImportChipKind; label: string } {
  return agent.isMain
    ? { kind: 'main', label: `Merges into ${mainName}` }
    : agent.existing
      ? { kind: 'update', label: 'Updates' }
      : { kind: 'new', label: 'New' };
}

function AgentDetail({ agent }: { agent: PasteImportAgent }) {
  return (
    <>
      <ImportSection title="Instructions">
        {agent.instructions ? (
          <p className="agents-import-agent__instructions">{agent.instructions}</p>
        ) : (
          <p className="agents-import-agent__none">None came across.</p>
        )}
      </ImportSection>
      <ImportSection title="Memory">
        {agent.memory.length ? (
          <ul className="agents-import-agent__memory">
            {agent.memory.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        ) : (
          <p className="agents-import-agent__none">Nothing remembered yet.</p>
        )}
      </ImportSection>
      {agent.routines.length > 0 && (
        <section>
          <h4>Routines</h4>
          <ul className="agents-import-agent__routines">
            {agent.routines.map((r, i) => (
              <li key={i} data-refused={r.refused ? '' : undefined}>
                {r.refused ? <WarningIcon size={12} /> : <CheckIcon size={12} />}
                <span>
                  {r.refused ? (
                    <>
                      Won’t be set: &ldquo;{r.when}&rdquo;. {r.refused}
                    </>
                  ) : (
                    <>
                      <strong>{r.schedule}</strong> {r.what}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function AgentRow({ agent, mainName }: { agent: PasteImportAgent; mainName: string }) {
  const refused = agent.routines.filter((r) => r.refused).length;
  return (
    <ImportAgentRow
      name={agent.name}
      // The main one becomes the Chief of Staff, so it wears that badge.
      avatarName={agent.isMain ? mainName : agent.name}
      color={agent.color ?? 'gray'}
      chip={chipFor(agent, mainName)}
      role={agent.role || undefined}
      counts={
        <>
          {counts(agent)}
          {refused > 0 && (
            <span className="agents-import-agent__warn">
              {' · '}
              {refused === 1 ? '1 won’t be set' : `${refused} won’t be set`}
            </span>
          )}
        </>
      }
      detail={() => <AgentDetail agent={agent} />}
    />
  );
}

/** Calm and specific: what's wrong, where, and the easiest way out. */
export function ImportProblems({ title, items }: { title: string; items: ReactNode[] }) {
  return (
    <div className="agents-import-problems" role="alert">
      <WarningIcon size={14} className="agents-import-problems__icon" />
      <div>
        <p className="agents-import-problems__title">{title}</p>
        <ul>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Informational, not a problem: what to know before the agents get going
 * (paused routines, logins to enter again). Neutral, so it never reads as a
 * warning next to the amber one above.
 */
export function ImportNotes({ title, items }: { title?: string; items: ReactNode[] }) {
  if (!items.length) return null;
  return (
    <div className="agents-import-behind">
      <InfoIcon size={14} className="agents-import-behind__icon" />
      <div>
        {title && <p className="agents-import-behind__title">{title}</p>}
        <ul>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ImportPreview({ preview }: { preview: PasteImportPreview }) {
  const { agents, problems, source, blocks } = preview;
  const mainName = useAgentsList().find((a) => a.isMain)?.name ?? 'Chief of Staff';
  const refused = agents.reduce((n, a) => n + a.routines.filter((r) => r.refused).length, 0);
  return (
    <div className="agents-import-preview" aria-live="polite">
      {problems.length > 0 && (
        <ImportProblems
          title={
            problems.length === 1
              ? 'One thing to fix before this can come across'
              : `${problems.length} things to fix before this can come across`
          }
          items={[
            ...problems,
            <span key="hint" className="agents-import-problems__hint">
              Easiest fix: send these lines to your assistant and paste its new reply.
            </span>,
          ]}
        />
      )}
      {agents.length > 0 && (
        <>
          <p className="agents-import-preview__found">
            <strong>{plural(agents.length, 'agent')}</strong>
            {source ? ` from ${source}` : ''}
            {blocks > 1 ? `, in ${blocks} parts` : ''}
            {refused > 0 && (
              <span className="agents-import-agent__warn">
                {' · '}
                {plural(refused, 'routine')} can’t be set as written
              </span>
            )}
          </p>
          <ul className="agents-import-preview__list">
            {agents.map((a) => (
              <AgentRow key={`${a.isMain}-${a.name}`} agent={a} mainName={mainName} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface ImportDoneProps {
  summary: ImportSummary;
  /** Only `name`, `isMain` and `color` are read. */
  agents: Pick<PasteImportAgent, 'name' | 'isMain' | 'color'>[];
  /** What this path has to say beyond the shared summary. */
  extra?: ReactNode;
}

/** A short celebration, what happened in one line, and what to do next. */
export function ImportDone({ summary, agents, extra }: ImportDoneProps) {
  const team = useAgentsList();
  const mainName = team.find((a) => a.isMain)?.name ?? 'Chief of Staff';
  const skipped = new Set(summary.skipped.map(([name]) => name));
  const arrived = agents.filter((a) => !skipped.has(a.name));
  const line = [
    summary.created.length ? `${plural(summary.created.length, 'new agent')}` : '',
    summary.updated.length ? `${summary.updated.length} updated` : '',
    summary.routinesSet.length ? `${plural(summary.routinesSet.length, 'routine')} set` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="agents-import-done" role="status">
      <span className="agents-import-done__mark" aria-hidden>
        <CheckIcon size={22} />
      </span>
      <h3 className="agents-import-done__title">
        {arrived.length ? 'Your team is here' : 'Nothing came across'}
      </h3>
      {line && <p className="agents-import-done__line">{line}</p>}
      {arrived.length > 0 && (
        <ul className="agents-import-done__team" aria-label="Imported agents">
          {arrived.map((a) => {
            const name = a.isMain ? mainName : a.name;
            return (
              <li key={`${a.isMain}-${a.name}`}>
                <AgentAvatar name={name} color={a.color ?? 'gray'} size="mini" />
                {name}
              </li>
            );
          })}
        </ul>
      )}
      {(summary.skipped.length > 0 || summary.routinesRefused.length > 0) && (
        <ImportProblems
          title="A few things didn’t come across"
          items={[
            ...summary.skipped.map(([name, why]) => (
              <>
                <strong>{name}</strong> wasn’t imported. {why}
              </>
            )),
            ...summary.routinesRefused.map((r) => (
              <>
                <strong>{r.agent}</strong>: &ldquo;{r.when}&rdquo; wasn’t scheduled. {r.detail}
              </>
            )),
            ...(summary.routinesRefused.length
              ? [
                  <span key="hint" className="agents-import-problems__hint">
                    Ask {listOf([...new Set(summary.routinesRefused.map((r) => r.agent))])} to
                    schedule {summary.routinesRefused.length === 1 ? 'it' : 'them'} in plain words.
                  </span>,
                ]
              : []),
          ]}
        />
      )}
      {extra}
      <p className="agents-import-done__next">
        <strong>Say hi to your team.</strong> They start when you message them; routines run while
        the app is open.
      </p>
    </div>
  );
}
