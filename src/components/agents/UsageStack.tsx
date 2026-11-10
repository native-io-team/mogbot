/**
 * The stack of accounts, drawn: one segmented meter (each account a
 * segment, in the order turns try them, filled to what its tighter limit
 * has left), and each account as a key card in the Usage view.
 *
 * A segment with no reading is an empty, dashed slot. A second sign-in of
 * an account already in the stack draws no segment (callers pass the
 * glance's `meterKeys`) and gets one line under the meter (`SameNotes`);
 * its key says so plainly, with "Sign in with a different account" and
 * "Remove". The account in use is drawn in full ink; the rest quieter.
 * Status hues only when an account is low; out of usage is neutral (it
 * resets by itself).
 *
 * @module components/agents/UsageStack
 */

import { useState, type CSSProperties } from 'react';
import {
  ClaudeIcon,
  CodexIcon,
  EditIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  ResetIcon,
  TrashIcon,
  ChevronRightIcon,
  WarningIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextField } from '../primitives/TextField';
import { StatusPill, type StatusTone } from '../primitives/StatusPill';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { DragSortHandle } from '../primitives/DragSort';
import type { AgentEngine } from '../../lib/agents';
import {
  LOW_LEFT,
  REMOVE_ACCOUNT,
  SIGN_IN_DIFFERENT,
  type KeyLimit,
  type AccountKeyState,
  type StackKey,
} from '../../lib/agentsUsage';
import { USE_THIS_ONE_NOW } from '../../../packages/companion-protocol/src/cardWords';
import { pinnedLine } from '../../../packages/companion-protocol/src/accountSwitcher';

export const ENGINE_ICON: Record<AgentEngine, typeof ClaudeIcon> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
};

/** The meter's words for one segment, for screen readers and the tooltip. */
export function segmentWords(k: StackKey): string {
  if (k.state === 'same' || k.state === 'off') return `${k.name}: ${k.stateLabel.toLowerCase()}`;
  if (k.left === null) return `${k.name}: no reading yet`;
  if (k.state === 'out') return `${k.name}: ${k.stateLabel.toLowerCase()}`;
  return `${k.name}: ${k.left}% left`;
}

export function StackMeter({
  keys,
  size = 'small',
  labelled = false,
  paced = false,
}: {
  keys: StackKey[];
  size?: 'small' | 'large';
  /** Name each segment under it (the Usage view's hero). */
  labelled?: boolean;
  /** Mark where each segment would stand at an even pace through its window. */
  paced?: boolean;
}) {
  const words = keys.map(segmentWords).join('; ');
  return (
    <span className="usage-stack" data-size={size} role="img" aria-label={`Room left. ${words}`}>
      <span className="usage-stack__track">
        {keys.map((k) => (
          <span
            key={k.key}
            className="usage-stack__seg"
            data-state={k.state}
            data-tone={k.tone}
            data-unread={k.left === null || undefined}
            title={segmentWords(k)}
          >
            <span
              className="usage-stack__fill"
              style={{ '--usage-stack-fill': `${k.left ?? 0}%` } as CSSProperties}
            />
            {paced && k.tight?.evenLeft !== undefined && (
              <span
                className="usage-stack__even"
                style={{ '--usage-stack-even': `${k.tight.evenLeft}%` } as CSSProperties}
                aria-hidden
              />
            )}
          </span>
        ))}
      </span>
      {labelled && (
        <span className="usage-stack__labels" aria-hidden>
          {keys.map((k) => (
            <span key={k.key} className="usage-stack__label" data-state={k.state}>
              <span className="usage-stack__label-name">{k.name}</span>
              <span className="usage-stack__label-room">
                {k.state === 'same'
                  ? 'Adds no extra room'
                  : k.state === 'off'
                    ? 'Not signed in'
                    : k.left === null
                      ? 'No reading'
                      : `${k.left}% left`}
              </span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** Under a meter: each account signed in twice, which draws no segment of its own. */
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

const PILL: Record<AccountKeyState, StatusTone> = {
  in_use: 'done',
  next: 'idle',
  ready: 'idle',
  out: 'out',
  off: 'idle',
  same: 'waiting',
  unread: 'idle',
};

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
function LimitRow({ limit }: { limit: KeyLimit }) {
  return (
    <div className="usage-key__limit" data-tone={limit.tone} data-model={limit.model || undefined}>
      <div className="usage-key__limit-head">
        <span className="usage-key__limit-name">{limit.label}</span>
        {limit.countdown && (
          <span className="usage-key__chip" title={`Refills ${limit.resetsAt ?? ''}`}>
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

export interface KeyActions {
  onUse: () => void;
  onSignIn: () => void;
  onRename: (name: string) => Promise<boolean>;
  onRemove: () => void;
}

/** One account as a key: its place, name, state, limits, who used it, and what to do. */
export function UsageKey({
  k,
  draggable,
  actions,
}: {
  k: StackKey;
  /** More than one account: it can be moved in the order. */
  draggable: boolean;
  actions: KeyActions;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(k.name);
  const [confirming, setConfirming] = useState(false);
  const [story, setStory] = useState(false);
  const pinned = pinnedLine(k.pinnedBy);
  const Icon = ENGINE_ICON[k.engine];
  const save = async () => {
    if (!name.trim() || name.trim() === k.name) {
      setName(k.name);
      return setEditing(false);
    }
    if (await actions.onRename(name)) setEditing(false);
  };

  return (
    <article
      className="usage-key"
      data-state={k.state}
      data-tone={k.tone}
      data-account={k.id}
      aria-label={`${k.position}. ${k.name}, ${k.stateLabel}`}
    >
      <div className="usage-key__head">
        {draggable ? (
          <DragSortHandle
            className="usage-key__grip"
            label={`Move ${k.name} in the order`}
            visibility="always"
          />
        ) : null}
        <span className="usage-key__cap" aria-hidden>
          {k.position}
        </span>
        <div className="usage-key__title">
          <div className="usage-key__name-row">
            <Icon size={14} />
            {editing ? (
              <TextField
                className="usage-key__name-field"
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
              <span className="usage-key__name">{k.name}</span>
            )}
            <StatusPill className="usage-key__state" tone={PILL[k.state]}>
              {k.stateLabel}
            </StatusPill>
          </div>
          {k.detail.length > 0 && <span className="usage-key__detail">{k.detail.join(' · ')}</span>}
        </div>
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

      {k.limits.length > 0 && (
        <div className="usage-key__limits">
          {k.limits.map((l) => (
            <LimitRow key={l.key} limit={l} />
          ))}
        </div>
      )}
      {k.signedIn && k.state !== 'same' && k.limits.length === 0 && k.state !== 'out' && (
        <span className="usage-key__muted">
          No usage reading yet. It shows after its next check or turn.
        </span>
      )}

      {k.fix && (
        <p className="usage-key__fix" data-action={k.fix.action}>
          {k.fix.text}
        </p>
      )}

      {k.spent.length > 0 && (
        <div className="usage-key__spent">
          <span className="usage-key__label">Used by these agents this week</span>
          <ul className="usage-key__spent-list">
            {k.spent.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {pinned && <span className="usage-key__muted">{pinned}</span>}

      {confirming ? (
        <div className="usage-key__actions">
          <span className="usage-key__muted">Remove its sign-in from this Mac?</span>
          <span className="usage-key__spacer" />
          <Button size="compact" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
          <Button size="compact" variant="danger" onClick={actions.onRemove}>
            Remove
          </Button>
        </div>
      ) : (
        <div className="usage-key__actions">
          {k.canUse && (
            <Button size="compact" variant="secondary" onClick={actions.onUse}>
              {USE_THIS_ONE_NOW}
            </Button>
          )}
          {k.fix?.action === 'sign_in' && (
            <Button size="compact" variant="secondary" onClick={actions.onSignIn}>
              Sign in
            </Button>
          )}
          {k.fix?.action === 'sign_in_other' && (
            <>
              <Button size="compact" variant="secondary" onClick={actions.onSignIn}>
                {SIGN_IN_DIFFERENT}
              </Button>
              {!k.thisMac && (
                <Button size="compact" variant="ghost" onClick={() => setConfirming(true)}>
                  {REMOVE_ACCOUNT}
                </Button>
              )}
            </>
          )}
          <span className="usage-key__spacer" />
          {k.changes.length > 0 && (
            <Button
              size="compact"
              variant="ghost"
              leftIcon={<HistoryIcon size={14} />}
              rightIcon={
                <ChevronRightIcon
                  size={12}
                  className="usage-key__chevron"
                  data-open={story || undefined}
                />
              }
              aria-expanded={story}
              data-usage-story
              onClick={() => setStory((s) => !s)}
            >
              Where did my usage go
            </Button>
          )}
        </div>
      )}

      {story && k.changes.length > 0 && (
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
          <li className="usage-key__story-note">
            Turns are listed with the tokens their engine reported; the points aren’t split between
            them. Use of the same plan outside these agents counts too.
          </li>
        </ol>
      )}
    </article>
  );
}
