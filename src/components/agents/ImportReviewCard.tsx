/**
 * The one card an import over the connector ends on (`agents/review.rs`):
 * every agent the other assistant proposed, for the user to check and keep.
 * Nothing exists until Import is pressed, and then only what's ticked.
 *
 * The rules it shows are the backend's: a name already taken here comes in as
 * a copy ("Finance (from Grok)") unless the user picks Replace, which shows
 * the instruction diff first; routines arrive paused; logins are asked for on
 * secure cards; no permissions come across; the Chief's own notes are an
 * optional item, off unless ticked.
 *
 * @module components/agents/ImportReviewCard
 */

import { memo, useMemo, useState } from 'react';
import { CheckIcon, ChevronRightIcon, DownloadIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  applyImportReview,
  copyName,
  type AgentMessage,
  type ConnectorCard,
  type ImportPicks,
  type ImportProposal,
} from '../../lib/agents';
import { plural } from './ImportParts';

/** Line diff, current → proposed: what Replace would change. Small inputs only. */
export function lineDiff(
  before: string,
  after: string
): { kind: 'same' | 'del' | 'add'; text: string }[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Longest common subsequence over lines; instructions are a page, not a book.
  const n = a.length;
  const m = b.length;
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

type Choice = 'copy' | 'replace';

interface RowProps {
  proposal: ImportProposal;
  source: string;
  kept: boolean;
  choice: Choice;
  disabled: boolean;
  onKeep: (kept: boolean) => void;
  onChoice: (choice: Choice) => void;
}

function ProposalRow({ proposal: p, source, kept, choice, disabled, onKeep, onChoice }: RowProps) {
  const [open, setOpen] = useState(false);
  const memory = p.memory.split('\n').filter((l) => l.trim());
  const arrivesAs = p.clash && choice === 'copy' ? copyName(p.name, source) : p.name;
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
                {choice === 'replace' ? `Replaces your ${p.name}` : 'Name taken here'}
              </span>
            )}
          </span>
          {p.role && <span className="agent-import-review__role">{p.role}</span>}
          <span className="agent-import-review__counts">
            {[
              p.instructions && `${p.instructions.length.toLocaleString()} chars of instructions`,
              memory.length && `${memory.length} ${memory.length === 1 ? 'memory' : 'memories'}`,
              p.routines.length && `${plural(p.routines.length, 'routine')} (paused)`,
              p.logins.length && plural(p.logins.length, 'login'),
            ]
              .filter(Boolean)
              .join(' · ') || 'Name and role only'}
          </span>
          <ChevronRightIcon size={12} className="agent-import-review__chevron" />
        </button>
      </div>
      {open && (
        <div className="agent-import-review__detail">
          {p.clash && kept && (
            <div className="agent-import-review__clash">
              <SegmentedControl<Choice>
                aria-label={`What to do with your ${p.name}`}
                value={choice}
                onValueChange={onChoice}
                options={[
                  { value: 'copy', label: `Add as ${copyName(p.name, source)}` },
                  { value: 'replace', label: `Replace your ${p.name}` },
                ]}
              />
              {choice === 'replace' && (
                <>
                  <p className="agent-import-review__warn">
                    Your {p.name}’s instructions become these. Its memory is kept and its “Always
                    allow” rules are removed.
                  </p>
                  <pre className="agent-import-review__diff" aria-label="What changes">
                    {lineDiff(p.clash.instructions, p.instructions).map((l, i) => (
                      <span key={i} data-kind={l.kind}>
                        {l.kind === 'del' ? '− ' : l.kind === 'add' ? '+ ' : '  '}
                        {l.text || ' '}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                </>
              )}
            </div>
          )}
          <h4>Instructions</h4>
          {p.instructions ? (
            <pre className="agent-import-review__text">{p.instructions}</pre>
          ) : (
            <p className="agent-import-review__muted">None sent.</p>
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
  const review = card.review;
  const proposals = useMemo(() => review?.proposals ?? [], [review]);
  const [kept, setKept] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(proposals.map((p) => [p.key, true]))
  );
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [notes, setNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const { showToast } = useOptionalToast();
  const pending = approval.status === 'pending';
  const count = proposals.filter((p) => kept[p.key]).length;

  const submit = async (picks: ImportPicks | null) => {
    setBusy(true);
    try {
      if (picks) await applyImportReview(message.agentId, approval.requestId, picks);
      else await onAnswer(approval.requestId, false);
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
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
            Nothing is created until you import, and only what’s ticked. Routines arrive paused,
            logins are asked for on secure cards, and no permissions come across.
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
                choice={choice[p.key] ?? 'copy'}
                disabled={!pending || busy}
                onKeep={(v) => setKept((k) => ({ ...k, [p.key]: v }))}
                onChoice={(c) => setChoice((x) => ({ ...x, [p.key]: c }))}
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
                    .map((p) => ({ key: p.key, replace: choice[p.key] === 'replace' })),
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
