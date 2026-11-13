/**
 * Usage, drawn, and said as what is USED everywhere: every figure "N% used",
 * every bar filling with use (a full bar is out), the warning role from
 * `HIGH_USED`, "Out until <refill>" at 100%. The total first: ONE ordinary
 * bar filled to what is used across every account (`TotalBar`), so two
 * accounts at 50% read as one bar half full. Then each account as one row
 * (`AccountRow`) with its own bar, % used, refill, who uses it and "Use for
 * new work", opening its own page
 * (`AccountDetail`): its limit cards against pace, who used it, where its
 * usage went, and what to do with it.
 *
 * Nothing read is an empty, dashed track, never room. A second sign-in of
 * an account already counted gets one line under the bar (`SameNotes`);
 * its row and page say so plainly, with "Sign in with a different account"
 * and "Remove". A bar and its figure take the warning role from 80% used
 * (used up too); the state pills stay neutral (it refills by itself).
 * Never the accent.
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
  OUT_OF_USAGE,
  REMOVE_ACCOUNT,
  SIGN_IN_DIFFERENT,
  type KeyLimit,
  type AccountKeyState,
  type StackKey,
  type UsageTotal,
} from '../../lib/agentsUsage';
import {
  NEW_WORK_HERE,
  NEW_WORK_PILL,
  USE_THIS_ONE_NOW,
} from '../../../packages/companion-protocol/src/cardWords';
import {
  usedTone,
  usersLine,
  type GlanceUsed,
} from '../../../packages/companion-protocol/src/usageGlance';
import { pinnedLine } from '../../../packages/companion-protocol/src/accountSwitcher';
import { AgentKey } from './AgentKey';
import { THIS_COMPUTER } from '../../lib/computer';

export const ENGINE_ICON: Record<AgentEngine, typeof ClaudeIcon> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  opencode: OpencodeIcon,
};

/* ------------------------------------------------------------ the total */

/**
 * The total as ONE ordinary bar, filled to what is used across every
 * account, as the figure beside it says it ("45% used" is a bar 45% full).
 * Never a segment per account: two accounts at 50% each read as one bar
 * half full, not two quarter-bars (the owner's "two 25s"). The accounts,
 * each with its own bar, are the rows one level down. Nothing read: an
 * empty dashed track, never a full one.
 */
export function TotalBar({
  total,
  size = 'small',
}: {
  total: UsageTotal;
  size?: 'small' | 'large';
}) {
  if (total.segments.length === 0) return null;
  const used = total.used;
  return (
    <span
      className="usage-total"
      data-size={size}
      data-tone={total.tone}
      data-unread={used === null || undefined}
      {...(used === null
        ? // Nothing read has no value, and a meter must have one: an image with a name.
          { role: 'img', 'aria-label': 'Usage used: not read yet' }
        : {
            role: 'meter',
            'aria-label': 'Usage used, across accounts',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': used,
            'aria-valuetext': `${used}% used`,
          })}
    >
      {used !== null && (
        <span
          className="usage-total__fill"
          style={{ '--usage-total-fill': `${used}%` } as CSSProperties}
        />
      )}
    </span>
  );
}

/**
 * The glance's bar (`glanceUsed`): it fills with use, so 8% used is a short
 * fill and a full bar is out. Ordinary ink; the warning role from
 * `HIGH_USED`. Never accent. Nothing read draws nothing (the row says so).
 */
export function UsedBar({ used }: { used: GlanceUsed }) {
  if (used.used === null) return null;
  return (
    <span
      className="usage-used"
      data-tone={used.tone}
      role="meter"
      aria-label="Usage used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={used.used}
      aria-valuetext={used.figure}
    >
      <span
        className="usage-used__fill"
        style={{ '--usage-used-fill': `${used.used}%` } as CSSProperties}
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

/** What an account adds, in a row's words: "62% used", "Not read yet" (`StackKey.figure`). */
export function roomWords(k: StackKey): string {
  return k.figure;
}

/* ------------------------------------------------------- an account row */

/**
 * One account in the overview's list: its place, name, room, state and
 * refill; opens its page. Every row has the same two lines and the same
 * columns: under the name, its plan and who used it this week; the account
 * new work starts on says so in its state pill ("Starts new work"); every
 * other one that can take it offers "Use for new work" in the action column,
 * just left of the chevron, where a signed-out row's "Sign in" goes too.
 * The actions sit beside the row's button, never inside it, so each is its
 * own control for the keyboard and VoiceOver.
 */
export function AccountRow({
  k,
  onOpen,
  onSignIn,
  onUse,
}: {
  k: StackKey;
  onOpen: () => void;
  /** A signed-out account's one action, beside the row (never inside its button). */
  onSignIn?: () => void;
  /**
   * "Use for new work" (puts it first): given when its engine has another
   * account to switch from. The one new work starts on says so instead.
   */
  onUse?: () => void;
}) {
  const Icon = ENGINE_ICON[k.engine];
  const refill = k.refillLimit?.countdown;
  const users = usersLine(k);
  const startsHere = Boolean(onUse) && k.state === 'in_use';
  const second = [k.detail[0], usersLine(k, { short: true })].filter(Boolean).join(' · ');
  const secondFull = [k.detail[0], users].filter(Boolean).join(' · ');
  const action =
    k.state === 'off' && onSignIn ? (
      <Button
        variant="secondary"
        size="compact"
        className="usage-row__action"
        onClick={onSignIn}
        aria-label={`Sign in to ${k.name}`}
      >
        Sign in
      </Button>
    ) : onUse && !startsHere && k.canUse ? (
      <Button
        variant="ghost"
        size="compact"
        className="usage-row__action"
        data-testid="usage-use-for-new-work"
        onClick={onUse}
        aria-label={`${USE_THIS_ONE_NOW}: ${k.name}`}
      >
        {USE_THIS_ONE_NOW}
      </Button>
    ) : null;
  return (
    <li className="usage-row__item" data-current={startsHere || undefined}>
      <button
        type="button"
        className="usage-row"
        data-state={k.state}
        data-tone={k.tone}
        data-used-tone={usedTone(k.used)}
        data-unread={k.used === null || undefined}
        data-account={k.id}
        aria-label={`${k.position}. ${k.name}, ${roomWords(k)}, ${k.stateLabel}${
          startsHere ? `, ${NEW_WORK_HERE.toLowerCase()}` : ''
        }${refill ? `, refills in ${refill}` : ''}${users ? `. ${users}` : ''}. Open`}
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
          <span className="usage-row__detail" title={secondFull || undefined}>
            {/* Always a second line, so every row is the same height. */}
            {second || '\u00a0'}
          </span>
        </span>
        <span className="usage-row__bar" aria-hidden>
          {k.used !== null && (
            <span
              className="usage-row__fill"
              style={{ '--usage-row-fill': `${k.used}%` } as CSSProperties}
            />
          )}
        </span>
        {/* Signed out, the pill says it once. */}
        <span className="usage-row__left">{k.state === 'off' ? '' : roomWords(k)}</span>
        <span className="usage-row__state">
          {/* The row says it short; its refill chip says when, its page in full. */}
          <StatusPill tone={PILL[k.state]}>
            {startsHere ? NEW_WORK_PILL : k.state === 'out' ? OUT_OF_USAGE : k.stateLabel}
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
        {/* The action column, held open on every row of a list that has an
            action, so the columns line up whichever rows carry one. */}
        <span className="usage-row__slot" aria-hidden />
        <ChevronRightIcon size={14} className="usage-row__chevron" aria-hidden />
      </button>
      {action}
    </li>
  );
}

/* ------------------------------------------------------ a limit's card */

/**
 * A bar that fills with use, with the pace marker: where it would stand had
 * it been spent evenly through the window. A fill past the marker is ahead
 * of pace; short of it, room to spare.
 */
export function PaceBar({
  limit,
  size = 'large',
}: {
  limit: Pick<KeyLimit, 'label' | 'used' | 'evenUsed' | 'tone' | 'paceState'>;
  size?: 'small' | 'large';
}) {
  return (
    <span
      className="usage-pacebar"
      data-size={size}
      data-tone={limit.tone}
      data-pace={limit.paceState}
      role="meter"
      aria-label={`${limit.label} limit used`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={limit.used}
    >
      <span
        className="usage-pacebar__fill"
        style={{ '--usage-pacebar-fill': `${limit.used}%` } as CSSProperties}
      />
      {limit.evenUsed !== undefined && (
        <span
          className="usage-pacebar__even"
          style={{ '--usage-pacebar-even': `${limit.evenUsed}%` } as CSSProperties}
          title={`Even pace: ${limit.evenUsed}% used by now`}
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
        {limit.used >= 100 ? (
          <>
            Out
            <span className="usage-key__figure-unit">
              {limit.resetsAt ? ` until ${limit.resetsAt}` : ' of usage'}
            </span>
          </>
        ) : (
          <>
            {limit.used}%<span className="usage-key__figure-unit"> used</span>
          </>
        )}
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
      {limit.resetsAt && limit.used < 100 && (
        <span className="usage-key__reset">Refills {limit.resetsAt}</span>
      )}
      {limit.pace && (
        // An estimate: secondary ink, never amber; a small mark only from HIGH_USED.
        <span className="usage-key__pace" title={limit.pace.basis}>
          {limit.tone !== 'calm' && (
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
          <p className="usage-bar__text">
            Remove {k.name}’s sign-in from {THIS_COMPUTER}?
          </p>
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
                {k.signedIn ? 'Sign in again' : 'Sign in'}
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
