/**
 * The one card an import over the connector ends on (`agents/review.rs`):
 * every agent the other assistant proposed, for the user to check and keep.
 * Nothing exists until Import is pressed, and then only what's ticked.
 *
 * Each agent's instructions are on the card from the start (the first lines,
 * then "Show all"): agents arrive ticked, so what they would run is in view
 * before Import, not behind a row that has to be opened.
 *
 * The rules it shows are the backend's: a name already taken here (or one
 * that only looks like it) comes in as a copy ("Finance (from Grok)") unless
 * the user picks Replace, which lists every consequence first (new
 * instructions as a diff, a fresh conversation, routines paused, project
 * unbound, Always-allow rules and, unless kept, saved logins removed);
 * routines arrive paused; logins are asked for on secure cards; no
 * permissions come across; the Chief's own notes are an optional item, off
 * unless ticked. Only this card imports: the phone shows "Review on your Mac".
 *
 * @module components/agents/ImportReviewCard
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { CheckIcon, ChevronRightIcon, DownloadIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { TextButton } from '../primitives/TextButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  applyImportReview,
  copyName,
  currentImportReview,
  type AgentMessage,
  type ConnectorCard,
  type ImportClash,
  type ImportPicks,
  type ImportProposal,
} from '../../lib/agents';
import { plural } from './ImportParts';

/** Past this, a line diff isn't drawn: both texts are shown whole instead. */
const MAX_DIFF_CHARS = 40_000;
const MAX_DIFF_CELLS = 1_000_000;

/**
 * Line diff, current → proposed: what Replace would change. `null` when the
 * texts are too big to diff here without freezing the window (the table is
 * lines × lines): the card then shows both in full.
 */
export function lineDiff(
  before: string,
  after: string
): { kind: 'same' | 'del' | 'add'; text: string }[] | null {
  if (before.length + after.length > MAX_DIFF_CHARS) return null;
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;
  // Longest common subsequence over lines.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: { kind: 'same' | 'del' | 'add'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: 'del', text: a[i++] });
    else out.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

/** Lines of an agent's instructions shown before "Show all". */
export const PREVIEW_LINES = 6;

/**
 * An agent's instructions, on the card before anything else about it: the
 * first lines inline and the rest one click away, so what an import would
 * run is read before Import, never hidden behind a row that has to be opened.
 */
function Instructions({ name, text }: { name: string; text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > PREVIEW_LINES;
  return (
    <div className="agent-import-review__instructions">
      <pre
        className="agent-import-review__text agent-import-review__text--preview"
        data-all={all || undefined}
        aria-label={`${name}’s instructions`}
      >
        {all || !long ? text : `${lines.slice(0, PREVIEW_LINES).join('\n')}…`}
      </pre>
      {long && (
        <TextButton onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </TextButton>
      )}
    </div>
  );
}

const lastSegment = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/** Every consequence of Replace, said plainly, for this agent as it is now. */
function ReplaceConsequences({
  proposal: p,
  clash,
  keepLogins,
  disabled,
  onKeepLogins,
}: {
  proposal: ImportProposal;
  clash: ImportClash;
  keepLogins: boolean;
  disabled: boolean;
  onKeepLogins: (keep: boolean) => void;
}) {
  const yours = clash.name || p.name;
  const diff = lineDiff(clash.instructions, p.instructions);
  const logins = clash.logins ?? [];
  const routines = clash.activeRoutines ?? 0;
  const rules = clash.rules ?? 0;
  return (
    <>
      <ul className="agent-import-review__consequences" aria-label={`Replacing your ${yours}`}>
        <li>Its instructions become these. Its memory is kept.</li>
        {p.role && p.role !== clash.role && (
          <li>
            Its role becomes “{p.role}”{clash.role ? ` (now “${clash.role}”)` : ''}.
          </li>
        )}
        {clash.conversation && <li>It starts a fresh conversation.</li>}
        {routines > 0 && (
          <li>{routines === 1 ? 'Its routine is' : `Its ${routines} routines are`} paused.</li>
        )}
        {clash.project && <li>It’s no longer bound to {lastSegment(clash.project)}.</li>}
        {rules > 0 && (
          <li>
            {rules === 1 ? 'Its “Always allow” rule is' : `Its ${rules} “Always allow” rules are`}{' '}
            removed.
          </li>
        )}
        {logins.length > 0 && (
          <li>
            {keepLogins
              ? `It keeps its saved logins: ${logins.join(', ')}.`
              : `Its saved logins are removed: ${logins.join(', ')}.`}
          </li>
        )}
      </ul>
      {logins.length > 0 && (
        <label className="agent-import-review__keep">
          <Checkbox
            checked={keepLogins}
            disabled={disabled}
            onChange={onKeepLogins}
            label="Keep its saved logins"
          />
          <span aria-hidden>Keep its saved logins</span>
        </label>
      )}
      {diff ? (
        <pre className="agent-import-review__diff" aria-label="What changes">
          {diff.map((l, i) => (
            <span key={i} data-kind={l.kind}>
              {l.kind === 'del' ? '− ' : l.kind === 'add' ? '+ ' : '  '}
              {l.text || ' '}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : (
        <>
          <p className="agent-import-review__muted">
            The instructions differ. Both are too long to compare line by line, so here are both.
          </p>
          <h4>Your {yours}’s now</h4>
          <pre className="agent-import-review__text">{clash.instructions}</pre>
          <h4>What they become</h4>
          <pre className="agent-import-review__text">{p.instructions}</pre>
        </>
      )}
    </>
  );
}

type Choice = 'copy' | 'replace';

interface RowProps {
  proposal: ImportProposal;
  source: string;
  kept: boolean;
  choice: Choice;
  keepLogins: boolean;
  disabled: boolean;
  onKeep: (kept: boolean) => void;
  onChoice: (choice: Choice) => void;
  onKeepLogins: (keep: boolean) => void;
}

function ProposalRow({
  proposal: p,
  source,
  kept,
  choice,
  keepLogins,
  disabled,
  onKeep,
  onChoice,
  onKeepLogins,
}: RowProps) {
  const [open, setOpen] = useState(false);
  const memory = p.memory.split('\n').filter((l) => l.trim());
  const arrivesAs = p.clash && choice === 'copy' ? copyName(p.name, source) : p.name;
  const yours = p.clash?.name || p.name;
  // "Ѕite" (Cyrillic Ѕ) is matched to your Site, and the card says so.
  const lookalike = !!p.clash?.name && p.clash.name.toLowerCase() !== p.name.toLowerCase();
  const counts = [
    memory.length && `${memory.length} ${memory.length === 1 ? 'memory' : 'memories'}`,
    p.routines.length && `${plural(p.routines.length, 'routine')} (paused)`,
    p.logins.length && plural(p.logins.length, 'login'),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li
      className="agent-import-review__agent"
      data-open={open || undefined}
      data-kept={kept || undefined}
    >
      <div className="agent-import-review__row">
        <Checkbox checked={kept} disabled={disabled} onChange={onKeep} label={`Import ${p.name}`} />
        <button
          type="button"
          className="agent-import-review__summary"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="agent-import-review__name">
            {arrivesAs}
            {p.clash && (
              <span
                className="agent-import-review__chip"
                data-tone={choice === 'replace' ? 'warn' : undefined}
              >
                {choice === 'replace'
                  ? `Replaces your ${yours}`
                  : lookalike
                    ? `Looks like your ${yours}`
                    : 'Name taken here'}
              </span>
            )}
          </span>
          {p.role && <span className="agent-import-review__role">{p.role}</span>}
          {(counts || !p.instructions) && (
            <span className="agent-import-review__counts">{counts || 'Name and role only'}</span>
          )}
          <ChevronRightIcon size={12} className="agent-import-review__chevron" />
        </button>
      </div>
      {p.instructions && (
        <div className="agent-import-review__inline">
          <Instructions name={p.name} text={p.instructions} />
        </div>
      )}
      {open && (
        <div className="agent-import-review__detail">
          {p.clash && kept && (
            <div className="agent-import-review__clash">
              <SegmentedControl<Choice>
                aria-label={`What to do with your ${yours}`}
                value={choice}
                onValueChange={onChoice}
                options={[
                  { value: 'copy', label: `Add as ${copyName(p.name, source)}` },
                  { value: 'replace', label: `Replace your ${yours}` },
                ]}
              />
              {choice === 'replace' && (
                <ReplaceConsequences
                  proposal={p}
                  clash={p.clash}
                  keepLogins={keepLogins}
                  disabled={disabled}
                  onKeepLogins={onKeepLogins}
                />
              )}
            </div>
          )}
          {memory.length > 0 && (
            <>
              <h4>What it remembers</h4>
              <ul className="agent-import-review__list">
                {memory.map((line, i) => (
                  <li key={i}>{line.replace(/^\s*[-•]\s*/, '')}</li>
                ))}
              </ul>
            </>
          )}
          {p.routines.length > 0 && (
            <>
              <h4>Routines · arrive paused</h4>
              <ul className="agent-import-review__list">
                {p.routines.map((r, i) => (
                  <li key={i}>
                    <strong>{r.schedule ?? r.when}</strong> · {r.what}
                    {r.refused && (
                      <span className="agent-import-review__refused">
                        {' '}
                        Won’t be set: {r.refused}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {p.logins.length > 0 && (
            <>
              <h4>Logins it asks for · on secure cards, never here</h4>
              <ul className="agent-import-review__list">
                {p.logins.map((l) => (
                  <li key={l.name}>
                    <code>{l.name}</code>
                    {l.purpose && ` · ${l.purpose}`}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!p.clash && memory.length === 0 && !p.routines.length && !p.logins.length && (
            <p className="agent-import-review__muted">Nothing else came with it.</p>
          )}
        </div>
      )}
    </li>
  );
}

interface ImportReviewCardProps {
  message: AgentMessage;
  card: ConnectorCard;
  chiefName: string;
  arrived?: boolean;
  /** Don't import: the chat's own card answer (Deny). */
  onAnswer: (requestId: string, allow: boolean) => Promise<void>;
}

export const ImportReviewCard = memo(function ImportReviewCard({
  message,
  card,
  chiefName,
  arrived,
  onAnswer,
}: ImportReviewCardProps) {
  const approval = message.approval!;
  const pending = approval.status === 'pending';
  // The card carries what it was posted with; what's taken here is read
  // again now (a card kept across a restart, an agent edited since), and
  // again after a refused Import.
  const { data: fresh, execute: refresh } = useAsyncState(() =>
    currentImportReview(message.agentId, approval.requestId)
  );
  useEffect(() => {
    if (pending) void refresh();
  }, [pending, refresh]);
  const review = fresh ?? card.review;
  const proposals = useMemo(() => review?.proposals ?? [], [review]);
  const [kept, setKept] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(proposals.map((p) => [p.key, true]))
  );
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [keepLogins, setKeepLogins] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const { showToast } = useOptionalToast();
  const count = proposals.filter((p) => kept[p.key]).length;

  const submit = async (picks: ImportPicks | null) => {
    setBusy(true);
    try {
      if (picks) await applyImportReview(message.agentId, approval.requestId, picks);
      else await onAnswer(approval.requestId, false);
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
      // A Replace refused because the agent changed: show it as it is now.
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const outcome =
    approval.status === 'allowed'
      ? (approval.choice ?? 'Imported')
      : approval.status === 'denied'
        ? 'Not imported. Nothing was created.'
        : approval.status === 'expired'
          ? 'The import was stopped. Nothing was created.'
          : null;

  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <section
        className="agent-import-review"
        data-status={approval.status}
        aria-label={approval.title}
        data-testid="agent-import-review"
      >
        <header className="agent-import-review__head">
          <DownloadIcon size={14} className="agent-import-review__icon" />
          <span className="agent-import-review__title">{approval.title}</span>
        </header>
        {pending && (
          <p className="agent-import-review__lede">
            Read each agent’s instructions before you import: they come from {card.source}. Only
            what’s ticked is created. Routines arrive paused, logins are asked for on secure cards,
            and no permissions come across.
          </p>
        )}
        {review?.summary && pending && (
          <p className="agent-import-review__summary-text">“{review.summary}”</p>
        )}
        {pending && (
          <ul className="agent-import-review__agents">
            {proposals.map((p) => (
              <ProposalRow
                key={p.key}
                proposal={p}
                source={card.source}
                kept={pending ? !!kept[p.key] : false}
                choice={p.clash ? (choice[p.key] ?? 'copy') : 'copy'}
                keepLogins={!!keepLogins[p.key]}
                disabled={!pending || busy}
                onKeep={(v) => setKept((k) => ({ ...k, [p.key]: v }))}
                onChoice={(c) => setChoice((x) => ({ ...x, [p.key]: c }))}
                onKeepLogins={(v) => setKeepLogins((x) => ({ ...x, [p.key]: v }))}
              />
            ))}
          </ul>
        )}
        {pending && review?.chiefNotes && (
          <div className="agent-import-review__notes">
            <Checkbox
              checked={pending && notes}
              disabled={!pending || busy}
              onChange={setNotes}
              label={`Add to ${chiefName}’s notes`}
            />
            <div>
              <span className="agent-import-review__notes-title">
                Add to {chiefName}’s notes{' '}
                <span className="agent-import-review__muted">
                  · what {card.source}’s managing agent knew. Off unless you tick it.
                </span>
              </span>
              <pre className="agent-import-review__text agent-import-review__text--short">
                {review.chiefNotes}
              </pre>
            </div>
          </div>
        )}
        {pending ? (
          <footer className="agent-import-review__actions">
            <Button variant="secondary" disabled={busy} onClick={() => void submit(null)}>
              Don’t import
            </Button>
            <Button
              variant="primary"
              disabled={busy || (count === 0 && !notes)}
              onClick={() =>
                void submit({
                  agents: proposals
                    .filter((p) => kept[p.key])
                    .map((p) => {
                      const replace = !!p.clash && choice[p.key] === 'replace';
                      return replace
                        ? {
                            key: p.key,
                            replace,
                            keepLogins: !!keepLogins[p.key],
                            seen: p.clash,
                          }
                        : { key: p.key, replace };
                    }),
                  chiefNotes: notes,
                })
              }
            >
              {count === 0 ? 'Import notes only' : `Import ${plural(count, 'agent')}`}
            </Button>
          </footer>
        ) : (
          <p className="agent-import-review__outcome" data-status={approval.status}>
            {approval.status === 'allowed' && <CheckIcon size={12} />}
            {outcome}
          </p>
        )}
      </section>
    </div>
  );
});
