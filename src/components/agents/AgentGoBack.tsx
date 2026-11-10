/**
 * Rewind, fork and edit on the desk (`agents/rewind.rs`; the words are
 * shared with the phone, `companion-protocol/src/rewind.ts`):
 *
 * - the "Go back" menu in a user message's hover actions,
 * - the confirm for Rewind to here and Fork from here,
 * - the composer's "Editing your message" bar, and
 * - the fold that holds what a rewind passed over ("Rewound · 4 messages").
 *
 * @module components/agents/AgentGoBack
 */

import { Fragment, isValidElement, useRef, type ReactElement, type ReactNode } from 'react';
import {
  BranchIcon,
  ChevronRightIcon,
  CloseIcon,
  MoreHorizontalIcon,
  PencilIcon,
  UndoIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { MenuButton } from '../primitives/MenuButton';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { TextButton } from '../primitives/TextButton';
import {
  EDITING_LINE,
  GO_BACK_LABELS,
  foldRewound,
  forkConfirm,
  goBackBlocked,
  goBackQuote,
  rewindConfirm,
  rewoundSummary,
  REWOUND_END,
  type GoBackAction,
} from '../../../packages/companion-protocol/src/rewind';

export type { GoBackAction };

export const GO_BACK_ICONS: Record<GoBackAction, ReactNode> = {
  edit: <PencilIcon size={14} />,
  fork: <BranchIcon size={14} />,
  rewind: <UndoIcon size={14} />,
};

export const GO_BACK_ORDER: GoBackAction[] = ['edit', 'fork', 'rewind'];
const ICONS = GO_BACK_ICONS;
const ORDER = GO_BACK_ORDER;

export interface GoBackState {
  agentName: string;
  /** A turn is running (or waiting for a slot). */
  working: boolean;
  /** The user is driving its session (take over). */
  driven: boolean;
}

/**
 * The menu on one of the user's own messages. Edit and Rewind wait for the
 * turn in progress (the reason is in the menu); Fork never does.
 */
export function GoBackMenu({
  state,
  onPick,
}: {
  state: GoBackState;
  onPick: (action: GoBackAction) => void;
}) {
  const reason = goBackBlocked('rewind', state);
  return (
    <Dropdown
      align="right"
      portal
      menuClassName="agent-go-back__menu"
      trigger={(p) => (
        <MenuButton
          {...p}
          tabIndex={-1}
          variant="ghost"
          size="compact"
          expanded={p['aria-expanded']}
          aria-label="Go back to here"
          title="Edit, fork or rewind"
        >
          <MoreHorizontalIcon size={12} />
        </MenuButton>
      )}
    >
      {ORDER.map((action) => (
        <DropdownItem
          key={action}
          icon={ICONS[action]}
          disabled={goBackBlocked(action, state) !== null}
          onSelect={() => onPick(action)}
        >
          {GO_BACK_LABELS[action]}
        </DropdownItem>
      ))}
      {reason && <p className="agent-go-back__reason">{reason}</p>}
    </Dropdown>
  );
}

/** What a confirm is about: Fork or Rewind on one message. */
export interface GoBackAsk {
  action: 'fork' | 'rewind';
  messageId: string;
  text: string;
}

/** Rewind to here? / Fork from here?: what happens, and what isn't undone. */
export function GoBackConfirm({
  ask,
  agentName,
  project,
  page,
  busy,
  onCancel,
  onConfirm,
}: {
  ask: GoBackAsk | null;
  agentName: string;
  /** A project-bound agent's project, for what its copy keeps. */
  project?: string | null;
  /** The conversation's living page's title, if it has one. */
  page?: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  if (!ask) return null;
  const words =
    ask.action === 'fork'
      ? forkConfirm(agentName, ask.text, project)
      : rewindConfirm(agentName, ask.text, project, page);
  return (
    <ModalFrame
      isOpen
      onClose={onCancel}
      dismissable={!busy}
      title={words.title}
      showCloseButton={false}
      className="agent-go-back__confirm"
      initialFocusRef={confirmRef}
    >
      <p className="agent-go-back__body">{words.body}</p>
      <div className="agent-go-back__actions">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          ref={confirmRef}
          variant="strong"
          onClick={onConfirm}
          disabled={busy}
          leftIcon={busy ? <Spinner size="sm" /> : ICONS[ask.action]}
        >
          {words.confirm}
        </Button>
      </div>
    </ModalFrame>
  );
}

/** Over the composer while a sent message is being edited. */
export function ComposerEditing({ text, onCancel }: { text: string | null; onCancel: () => void }) {
  if (text === null) return null;
  return (
    <div className="agent-composer__revising agent-go-back__editing">
      <span className="agent-quote-chip">
        <PencilIcon size={12} />
        <span className="agent-quote-chip__text">
          {EDITING_LINE}
          {goBackQuote(text) && <> “{goBackQuote(text)}”</>}
        </span>
        <IconButton
          variant="ghost"
          size="compact"
          className="agent-quote-chip__remove"
          icon={<CloseIcon size={12} />}
          onClick={onCancel}
          aria-label="Stop editing"
          title="Stop editing"
        />
      </span>
    </div>
  );
}

/**
 * The chat's rows with what a rewind passed over folded: each run starts
 * with "Rewound · N messages", and its rows are drawn only once it is
 * opened. Row count and order are unchanged (the working line and the setup
 * card are placed by index), and an opened row is still a direct child of
 * the chat, so its own styles hold.
 *
 * Opened, the run reads as past: the summary line heads it, "End of what
 * was rewound" closes it, and the rows between are muted behind a rule on
 * the left. That is drawn by sibling selectors between the two lines
 * (agents-chat.css), which is why only one run is open at a time
 * (`openOneFold`).
 */
export function foldRows<T>(
  rows: (ReactElement | null)[],
  items: readonly T[],
  rewound: Map<string, string>,
  idsOf: (item: T) => readonly string[],
  open: ReadonlySet<string>,
  onToggle: (rewindId: string) => void
): (ReactElement | null)[] {
  if (rewound.size === 0) return rows;
  const indexed = items.map((item, i) => ({ item, i }));
  const groups = foldRewound(indexed, rewound, (x) => idsOf(x.item));
  const out = [...rows];
  for (const group of groups) {
    if (group.kind !== 'rewound') continue;
    const count = group.items.reduce((n, x) => n + Math.max(1, idsOf(x.item).length), 0);
    const isOpen = open.has(group.rewindId);
    const last = group.items.length - 1;
    group.items.forEach(({ i }, at) => {
      const row = rows[i];
      const key = isValidElement(row) && row.key != null ? String(row.key) : `rewound-${i}`;
      const shown = isOpen ? row : null;
      const head =
        at === 0 ? (
          <div
            className="agent-note agent-go-back__summary"
            data-rewound={group.rewindId}
            data-open={isOpen || undefined}
          >
            <TextButton
              tabIndex={0}
              aria-expanded={isOpen}
              leftIcon={<UndoIcon size={12} />}
              rightIcon={<ChevronRightIcon size={12} className="agent-go-back__chevron" />}
              onClick={() => onToggle(group.rewindId)}
            >
              {rewoundSummary(count)}
            </TextButton>
          </div>
        ) : null;
      const tail =
        isOpen && at === last ? (
          <div className="agent-note agent-go-back__end" data-rewound-end={group.rewindId}>
            {REWOUND_END}
          </div>
        ) : null;
      if (!head && !tail) {
        out[i] = shown;
        return;
      }
      out[i] = (
        <Fragment key={key}>
          {head}
          {shown}
          {tail}
        </Fragment>
      );
    });
  }
  return out;
}

/** Opening a fold closes any other (see `foldRows`); toggling it again closes it. */
export function openOneFold(open: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return open.has(id) ? new Set() : new Set([id]);
}
