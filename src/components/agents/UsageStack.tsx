/**
 * Usage, drawn. The total first: one bar made of a segment per real
 * account, in the work order, each filled to what that account adds
 * (`TotalBar`), so 100% and 44% read at a glance as "most of my limit is
 * left". Then each account as one row (`AccountRow`) that opens its own
 * page (`AccountDetail`): its limit cards against pace, who used it, where
 * its usage went, and what to do with it.
 *
 * A segment with no reading is an empty, dashed slot, never room. A second
 * sign-in of an account already counted draws no segment and gets one line
 * under the bar (`SameNotes`); its row and page say so plainly, with "Sign
 * in with a different account" and "Remove". Status hues only when an
 * account is low; out of usage is neutral (it resets by itself). Never the
 * accent.
 *
 * Every figure is the glance's (`companion-protocol/usageGlance`).
 *
 * @module components/agents/UsageStack
 */

import { useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  ClaudeIcon,
  CodexIcon,
  OpencodeIcon,
  EditIcon,
  MoreHorizontalIcon,
  ResetIcon,
  TrashIcon,
  WarningIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextField } from '../primitives/TextField';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { StatusPill, type StatusTone } from '../primitives/StatusPill';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import type { AgentEngine } from '../../lib/agents';
import {
  LOW_LEFT,
  OUT_OF_USAGE,
  REMOVE_ACCOUNT,
  SIGN_IN_DIFFERENT,
  type KeyLimit,
  type AccountKeyState,
  type StackKey,
  type UsageTotal,
} from '../../lib/agentsUsage';
import { USE_THIS_ONE_NOW } from '../../../packages/companion-protocol/src/cardWords';
import { pinnedLine } from '../../../packages/companion-protocol/src/accountSwitcher';
import { AgentKey } from './AgentKey';

export const ENGINE_ICON: Record<AgentEngine, typeof ClaudeIcon> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  opencode: OpencodeIcon,
};

/* ------------------------------------------------------------ the total */

/**
 * The total as one bar: a segment per account, in the work order, each filled
 * to what it adds. Large, each segment and its label are one button that
 * opens that account; small (the sidebar row), it is a picture.
 */
export function TotalBar({
  total,
  size = 'small',
  onOpen,
  labelled = true,
}: {
  total: UsageTotal;
  size?: 'small' | 'large';
  /** Each segment's name and room under it (the large bar); off when a row below says it. */
  labelled?: boolean;
  /** Open an account's page (the large bar). */
  onOpen?: (engine: AgentEngine, id: string) => void;
}) {
  if (total.segments.length === 0) return null;
  const words = total.segments.map((s) => s.words).join('; ');
  if (!onOpen) {
    return (
      <span className="usage-total" data-size={size} role="img" aria-label={`Room left. ${words}`}>
        <span className="usage-total__track">
          {total.segments.map((s) => (
            <Segment key={s.key} left={s.left} state={s.state} tone={s.tone} />
          ))}
        </span>
      </span>
    );
  }
  return (
    <div className="usage-total" data-size={size} role="list" aria-label="Room left, by account">
      {total.segments.map((s) => (
        <div key={s.key} role="listitem" className="usage-total__item">
          <button
            type="button"
            className="usage-total__part"
            data-account={s.id}
            aria-label={`${s.words}. Open ${s.name}`}
            onClick={() => onOpen(s.engine, s.id)}
          >
            <Segment left={s.left} state={s.state} tone={s.tone} />
            {labelled && <span className="usage-total__name">{s.name}</span>}
            {labelled && (
              <span className="usage-total__room">
                <span className="usage-total__left">
                  {s.left === null ? 'Not read yet' : `${s.left}% left`}
                </span>
                {s.refill && (
                  <span
                    className="usage-chip"
                    title={s.refillAt ? `Refills ${s.refillAt}` : undefined}
                  >
                    <ResetIcon size={11} aria-hidden />
                    {s.refill}
                  </span>
                )}
              </span>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

function Segment({
  left,
  state,
  tone,
}: {
  left: number | null;
  state: AccountKeyState;
  tone: StackKey['tone'];
}) {
  return (
    <span
      className="usage-total__seg"
      data-state={state}
      data-tone={tone}
      data-unread={left === null || undefined}
      data-empty={left === 0 || undefined}
      aria-hidden
    >
      <span
        className="usage-total__fill"
        style={{ '--usage-total-fill': `${left ?? 0}%` } as CSSProperties}
      />
    </span>
  );
}

/** Under the bar: each account signed in twice, which draws no segment of its own. */
export function SameNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <>
      {notes.map((n) => (
        <p key={n} className="usage-stack-note" data-testid="usage-same-note">
          {n}
        </p>
      ))}
    </>
  );
}

export const PILL: Record<AccountKeyState, StatusTone> = {
  in_use: 'done',
  next: 'idle',
  ready: 'idle',
  out: 'out',
  off: 'idle',
  same: 'waiting',
  unread: 'idle',
};

/** What an account adds, in a row's words. */
export function roomWords(k: StackKey): string {
  if (k.state === 'same') return 'Adds no room';
  if (k.state === 'off') return 'Not signed in';
  if (k.share === null) return 'Not read yet';
  return `${k.share}% left`;
}

/* ------------------------------------------------------- an account row */

/** One account in the overview's list: its place, name, room, state and refill; opens its page. */
export function AccountRow({
  k,
  onOpen,
  onSignIn,
}: {
  k: StackKey;
  onOpen: () => void;
  /** A signed-out account's one action, beside the row (never inside its button). */
  onSignIn?: () => void;
}) {
  const Icon = ENGINE_ICON[k.engine];
  const refill = k.refillLimit?.countdown;
  return (
    <li className="usage-row__item">
      <button
        type="button"
        className="usage-row"
        data-state={k.state}
        data-tone={k.tone}
        data-unread={k.share === null || undefined}
        data-account={k.id}
        aria-label={`${k.position}. ${k.name}, ${roomWords(k)}, ${k.stateLabel}${
          refill ? `, refills in ${refill}` : ''
        }. Open`}
        onClick={onOpen}
      >
        <span className="usage-cap" aria-hidden>
          {k.position}
        </span>
        <span className="usage-row__who">
          <span className="usage-row__name">
            <Icon size={13} aria-hidden />
            <span className="usage-row__name-text">{k.name}</span>
          </span>
          {k.detail.length > 0 && <span className="usage-row__detail">{k.detail[0]}</span>}
        </span>
        <span className="usage-row__bar" aria-hidden>
          {k.share !== null && (
            <span
              className="usage-row__fill"
              style={{ '--usage-row-fill': `${k.share}%` } as CSSProperties}
            />
          )}
        </span>
        {/* Signed out, the pill says it once. */}
        <span className="usage-row__left">{k.state === 'off' ? '' : roomWords(k)}</span>
        <span className="usage-row__state">
          {/* The row says it short; its refill chip says when, its page in full. */}
          <StatusPill tone={PILL[k.state]}>
            {k.state === 'out' ? OUT_OF_USAGE : k.stateLabel}
          </StatusPill>
        </span>
        <span className="usage-row__refill">
          {refill && (
            <span className="usage-chip" title={`Refills ${k.refillLimit?.resetsAt ?? ''}`}>
              <ResetIcon size={11} aria-hidden />
              {refill}
            </span>
          )}
        </span>
        <ChevronRightIcon size={14} className="usage-row__chevron" aria-hidden />
      </button>
      {k.state === 'off' && onSignIn && (
        <Button
          variant="secondary"
          size="compact"
          className="usage-row__sign-in"
          onClick={onSignIn}
          aria-label={`Sign in to ${k.name}`}
        >
          Sign in
        </Button>
      )}
    </li>
  );
}

/* ------------------------------------------------------ a limit's card */

/**
 * A bar of what is left (solid) against what is used (hatched), with the
 * pace marker: where it would stand had it been spent evenly through the
 * window. Left of the marker is ahead of pace; right of it, room to spare.
 */
export function PaceBar({
  limit,
  size = 'large',
}: {
  limit: Pick<KeyLimit, 'label' | 'left' | 'evenLeft' | 'tone' | 'paceState'>;
  size?: 'small' | 'large';
}) {
  return (
    <span
      className="usage-pacebar"
      data-size={size}
      data-tone={limit.tone}
      data-pace={limit.paceState}
      role="meter"
      aria-label={`${limit.label} limit left`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={limit.left}
    >
      <span
        className="usage-pacebar__fill"
        style={{ '--usage-pacebar-fill': `${limit.left}%` } as CSSProperties}
      />
      {limit.evenLeft !== undefined && (
        <span
          className="usage-pacebar__even"
          style={{ '--usage-pacebar-even': `${limit.evenLeft}%` } as CSSProperties}
          title={`Even pace: ${limit.evenLeft}% left by now`}
          aria-hidden
        />
      )}
    </span>
  );
}

/**
 * One limit as a card: its name and countdown chip, the big figure, the
 * pace-marked bar, the time until it refills with the Mac's run-out
 * estimate marked on it (labelled as one), and what that means in words.
 */
export function LimitRow({ limit }: { limit: KeyLimit }) {
  return (
    <div className="usage-key__limit" data-tone={limit.tone} data-model={limit.model || undefined}>
      <div className="usage-key__limit-head">
        <span className="usage-key__limit-name">{limit.label}</span>
        {limit.countdown && (
          <span className="usage-chip" title={`Refills ${limit.resetsAt ?? ''}`}>
            <ResetIcon size={11} aria-hidden />
            {limit.countdown}
          </span>
        )}
      </div>
      <span className="usage-key__figure">
        {limit.left}%<span className="usage-key__figure-unit"> left</span>
      </span>
      <PaceBar limit={limit} />
      {limit.runOut && (
        <span
          className="usage-key__timeline"
          role="img"
          aria-label={`${limit.runOut.text}, an estimate`}
        >
          <span className="usage-key__timeline-track">
            <span
              className="usage-key__timeline-mark"
              style={
                {
                  '--usage-key-runout': `${Math.round(limit.runOut.along * 100)}%`,
                } as CSSProperties
              }
            />
          </span>
          <span className="usage-key__timeline-ends" aria-hidden>
            <span>Now</span>
            <span>{limit.runOut.text} · estimate</span>
            <span>Refills</span>
          </span>
        </span>
      )}
      {limit.paceWord && (
        <span className="usage-key__paceword" data-pace={limit.paceState}>
          {limit.paceWord}
        </span>
      )}
      {limit.resetsAt && <span className="usage-key__reset">Refills {limit.resetsAt}</span>}
      {limit.pace && (
        // An estimate: secondary ink, never amber; a small mark only when little is left.
        <span className="usage-key__pace" title={limit.pace.basis}>
          {limit.left <= LOW_LEFT && (
            <WarningIcon size={12} className="usage-key__pace-icon" aria-hidden />
          )}
          <span>
            {!limit.runOut && <>{limit.pace.text} · </>}
            <span className="usage-key__basis">{limit.pace.basis}</span>
          </span>
        </span>
      )}
    </div>
  );
}

/* ---------------------------------------------------- an account's page */

export interface KeyActions {
  onUse: () => void;
  onSignIn: () => void;
  onRename: (name: string) => Promise<boolean>;
  onRemove: () => void;
  /** Move it one place up or down in the order; absent at that end, or with one account. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function Section({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="usage-section" aria-labelledby={id}>
      <div className="usage-section__head">
        <h3 className="usage-section__title" id={id}>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * One account, in full: its name, state and what tells it apart, with
 * "Use this one now" and its menu (rename, move, sign in again, remove);
 * its notices; its limits against pace, or who used it (Limits | Tokens);
 * and where its usage went.
 */
export function AccountDetail({
  k,
  notice,
  actions,
  headingRef,
}: {
  k: StackKey;
  /** This account's own notice (this Mac's sign-in became another account). */
  notice?: ReactNode;
  actions: KeyActions;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(k.name);
  const [confirming, setConfirming] = useState(false);
  const [view, setView] = useState<'limits' | 'tokens'>('limits');
  const pinned = pinnedLine(k.pinnedBy);
  const Icon = ENGINE_ICON[k.engine];
  const save = async () => {
    if (!name.trim() || name.trim() === k.name) {
      setName(k.name);
      return setEditing(false);
    }
    if (await actions.onRename(name)) setEditing(false);
  };
  const tokens = view === 'tokens' && k.agents.length > 0;

  return (
    <article
      className="usage-account"
      data-state={k.state}
      data-account={k.id}
      aria-label={`${k.name}, ${k.stateLabel}`}
    >
      <header className="usage-account__head">
        {/* The cap says its place; the line beside it doesn't say it again. */}
        <span
          className="usage-cap"
          data-size="large"
          data-state={k.state}
          title={`${ordinal(k.position)} in the order`}
        >
          <span aria-hidden>{k.position}</span>
          <span className="sr-only">{`${ordinal(k.position)} in the order`}</span>
        </span>
        <div className="usage-account__title">
          <div className="usage-account__name-row">
            <Icon size={16} aria-hidden />
            {editing ? (
              <TextField
                className="usage-account__name-field"
                value={name}
                maxLength={40}
                aria-label="Account name"
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void save()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') void save();
                  if (e.key === 'Escape') {
                    setName(k.name);
                    setEditing(false);
                  }
                }}
              />
            ) : (
              <h2 className="usage-account__name" tabIndex={-1} ref={headingRef}>
                {k.name}
              </h2>
            )}
            <StatusPill tone={PILL[k.state]}>{k.stateLabel}</StatusPill>
          </div>
          <span className="usage-account__detail">{k.detail.join(' · ')}</span>
        </div>
        <div className="usage-account__actions">
          {k.canUse && (
            <Button variant="secondary" onClick={actions.onUse}>
              {USE_THIS_ONE_NOW}
            </Button>
          )}
          <Dropdown
            align="right"
            portal
            quietOpen
            trigger={(p) => (
              <IconButton
                {...p}
                tabIndex={0}
                size="medium"
                variant="ghost"
                icon={<MoreHorizontalIcon size={14} />}
                aria-label={`More for ${k.name}`}
              />
            )}
          >
            <DropdownItem
              icon={<EditIcon size={14} />}
              onSelect={() => {
                setName(k.name);
                setEditing(true);
              }}
            >
              Rename
            </DropdownItem>
            {actions.onMoveUp && (
              <DropdownItem icon={<ArrowUpIcon size={14} />} onSelect={actions.onMoveUp}>
                Move up
              </DropdownItem>
            )}
            {actions.onMoveDown && (
              <DropdownItem icon={<ArrowDownIcon size={14} />} onSelect={actions.onMoveDown}>
                Move down
              </DropdownItem>
            )}
            {k.signedIn && !k.thisMac && (
              <DropdownItem icon={<ResetIcon size={14} />} onSelect={actions.onSignIn}>
                Sign in again
              </DropdownItem>
            )}
            {!k.thisMac && (
              <>
                <DropdownDivider />
                <DropdownItem
                  icon={<TrashIcon size={14} />}
                  variant="danger"
                  onSelect={() => setConfirming(true)}
                >
                  Remove…
                </DropdownItem>
              </>
            )}
          </Dropdown>
        </div>
      </header>

      {confirming && (
        <div className="usage-bar" role="alertdialog" aria-label="Remove this account">
          <p className="usage-bar__text">Remove {k.name}’s sign-in from this Mac?</p>
          <div className="usage-bar__actions">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button variant="danger" leftIcon={<TrashIcon size={14} />} onClick={actions.onRemove}>
              Remove
            </Button>
          </div>
        </div>
      )}

      {notice}

      {k.fix && (
        <div className="usage-bar" data-action={k.fix.action} data-testid="usage-account-fix">
          <p className="usage-bar__text">{k.fix.text}</p>
          <div className="usage-bar__actions">
            {k.fix.action === 'sign_in' && (
              <Button variant="secondary" onClick={actions.onSignIn}>
                Sign in
              </Button>
            )}
            {k.fix.action === 'sign_in_other' && (
              <>
                <Button variant="secondary" onClick={actions.onSignIn}>
                  {SIGN_IN_DIFFERENT}
                </Button>
                {!k.thisMac && (
                  <Button variant="ghost" onClick={() => setConfirming(true)}>
                    {REMOVE_ACCOUNT}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {pinned && <p className="usage-section__muted">{pinned}</p>}

      {k.state !== 'same' && k.signedIn && (
        <Section
          id={`usage-account-${k.id}-limits`}
          title={tokens ? 'Used by these agents this week' : 'Limits'}
          aside={
            k.agents.length > 0 ? (
              <div className="usage-switch" data-testid="usage-view-switch">
                <SegmentedControl
                  aria-label="Show limits or tokens"
                  value={view}
                  size="default"
                  options={[
                    { value: 'limits', label: 'Limits' },
                    { value: 'tokens', label: 'Tokens' },
                  ]}
                  onValueChange={(v) => setView(v)}
                />
              </div>
            ) : null
          }
        >
          {tokens ? (
            <AgentsTable k={k} />
          ) : k.limits.length > 0 ? (
            <div className="usage-key__limits">
              {k.limits.map((l) => (
                <LimitRow key={l.key} limit={l} />
              ))}
            </div>
          ) : (
            <p className="usage-section__muted">
              {k.state === 'out'
                ? k.stateLabel
                : 'Your usage shows here after an agent’s first reply.'}
            </p>
          )}
        </Section>
      )}

      {k.changes.length > 0 && (
        <Section id={`usage-account-${k.id}-story`} title="Where it went">
          <ol className="usage-key__story" aria-label={`Where ${k.name}’s usage went`}>
            {k.changes.map((c) => (
              <li
                key={c.key}
                className="usage-key__change"
                data-elsewhere={c.elsewhere ? true : undefined}
              >
                <div className="usage-key__change-head">
                  <span className="usage-key__change-title">{c.title}</span>
                  <span className="usage-key__change-when">{c.when}</span>
                </div>
                {c.runs.length > 0 && (
                  <ul className="usage-key__change-runs">
                    {c.runs.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
                {c.elsewhere && <p className="usage-key__elsewhere">{c.elsewhere}</p>}
              </li>
            ))}
          </ol>
          <p className="usage-section__muted">
            Each task shows the tokens its engine reported; a rise isn’t divided between tasks. Use
            of the same plan outside these agents counts too.
          </p>
        </Section>
      )}
    </article>
  );
}

/** Who used this account this week: agent key, name, tokens, messages, in aligned columns. */
function AgentsTable({ k }: { k: StackKey }) {
  return (
    <div className="usage-table" role="table" aria-label={`Who used ${k.name} this week`}>
      <div className="usage-table__row usage-table__row--head" role="row">
        <span role="columnheader" className="usage-table__agent">
          Agent
        </span>
        <span role="columnheader" className="usage-table__num">
          Tokens
        </span>
        <span role="columnheader" className="usage-table__num">
          Messages
        </span>
      </div>
      {k.agents.map((a) => (
        <div key={a.key} className="usage-table__row" role="row">
          <span role="cell" className="usage-table__agent">
            <AgentKey id={a.agentId} name={a.name} size="sm" />
            <span className="usage-table__name">{a.name}</span>
            <span
              className="usage-table__share"
              style={{ '--usage-table-share': `${a.share}%` } as CSSProperties}
              role="img"
              aria-label={`${a.share}% of its tokens`}
            />
          </span>
          <span role="cell" className="usage-table__num">
            {a.tokensText}
          </span>
          <span role="cell" className="usage-table__num">
            {a.turns}
          </span>
        </div>
      ))}
      <p className="usage-section__muted usage-table__note">
        Tokens as Claude Code or Codex reported them for what these agents did. Not a cost: your
        plan isn’t billed per token.
      </p>
    </div>
  );
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
