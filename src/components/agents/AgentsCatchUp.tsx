/**
 * Catch up on the desk, v3 (designs/catchup-v3, Julian's approval): one
 * centred 720px column. The decision on top, large, with the thing being
 * approved shown; what's next under it; what happened at the foot. Nothing is
 * a separate state: with nothing open, All clear sits where the card was.
 * Keys A, D, O and L work while the card has focus (`useCardGuard`); Esc
 * closes. Words are shared with the phone (`companion-protocol/catchUpWords`).
 *
 * @module components/agents/AgentsCatchUp
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { AgentKey } from './AgentKey';
import { useCardGuard } from './useCardGuard';
import { approvalKey } from './approvalKeys';
import { useRecentLines, useRoomCards } from './AgentsTeamView';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  agentKeyState,
  answerApproval,
  failedTurn,
  failurePill,
  summarizeTeam,
  type Agent,
  type Approval,
  type AgentMessage,
} from '../../lib/agents';
import { useAgentsSelector } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { formatAge, formatAgo } from '../../lib/formatAgo';
import { draftOf } from '../../lib/draftCard';
import {
  answersHere,
  catchItems,
  withRoomCards,
  withLater,
  type CatchItem,
} from '../../lib/catchUpDesk';
import { previewText } from '../../../packages/companion-protocol/src/preview';
import {
  CATCH_UP,
  CATCH_UP_EYEBROW,
  catchUpAllClearBody,
  catchUpMore,
} from '../../../packages/companion-protocol/src/catchUpWords';

interface Props {
  onOpenAgent: (id: string) => void;
  onOpenMessage: (agentId: string, messageId: string, conversation?: string) => void;
  onClose: () => void;
  /** The old overview, one click away. */
  onOpenInFlight: () => void;
}
/** What kind of ask it is, for the card's eyebrow. */
function kindOf(m: AgentMessage | undefined): string {
  const a = m?.approval;
  if (!a) return CATCH_UP_EYEBROW.didntFinish;
  return a.login || a.secret || a.prompt ? CATCH_UP_EYEBROW.needsInput : CATCH_UP_EYEBROW.needsOk;
}

/** The time now, for what is noticed during a render (kept out of the component body). */
const stamp = (): number => Date.now();

/** A clock time in the user's own format, lower-cased ("5:57 am"). */
const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();

/** The card's headline: what it is, in a line. */
const headline = (i: CatchItem): string => {
  if (i.message?.approval) return i.message.approval.title;
  // A turn that didn't finish: the ask is what it said when it stopped, not the
  // eyebrow's own words ("Didn't finish").
  const said = i.failure?.text.trim().split('\n')[0];
  return said || failurePill(failedTurn(i.agent)!, '', i.agent.engine).label;
};

/** Why, in two lines: the agent's own summary, else the first of the detail. */
function why(i: CatchItem): string {
  const a = i.message?.approval;
  if (!a) {
    const said = previewText(i.agent.preview) ?? '';
    return said === headline(i) ? '' : said;
  }
  const raw = a.summary?.trim() || a.detail?.trim() || '';
  const first = raw.split('\n')[0];
  // A raw tool call isn't a reason: its own words are one click away.
  return /^[{[]/.test(first) ? '' : first;
}

export function AgentsCatchUp({ onOpenAgent, onOpenMessage, onClose, onOpenInFlight }: Props) {
  const agents = useAgentsSelector((s) => s.agents);
  const messages = useAgentsSelector((s) => s.messages);
  const lines = useRecentLines(agents, messages);
  const team = useMemo(() => summarizeTeam(agents, lines), [agents, lines]);
  // Cards asked for in a room live in its thread, not the agent's own chat.
  const rooms = useAgentsSelector((s) => s.rooms);
  const roomCards = useRoomCards(agents, rooms, messages);
  const all = useMemo(
    () => catchItems(withRoomCards(team.needsYou, roomCards)),
    [team.needsYou, roomCards]
  );
  const [later, setLater] = useState<string[]>([]);
  const items = useMemo(() => withLater(all, later), [all, later]);

  // What was in the queue when it was seen, so an answered row can move to Done.
  const [seen, setSeen] = useState<CatchItem[]>([]);
  const [doneAt, setDoneAt] = useState<Record<string, number>>({});
  const missing = seen.filter((s) => !all.some((i) => i.key === s.key) && !(s.key in doneAt));
  const unseen = all.filter((i) => !seen.some((s) => s.key === i.key));
  if (unseen.length > 0) setSeen([...seen, ...unseen]);
  // An answered row moves to Done, stamped when it was noticed gone.
  if (missing.length > 0) {
    const at = stamp();
    setDoneAt({ ...doneAt, ...Object.fromEntries(missing.map((m) => [m.key, at])) });
  }
  const done = useMemo(
    () => seen.filter((s) => s.key in doneAt).sort((a, b) => doneAt[a.key] - doneAt[b.key]),
    [seen, doneAt]
  );
  const lastDecision =
    done.length > 0 ? clock(Math.max(...done.map((d) => doneAt[d.key]))) : undefined;

  // Open: the row the user picked, else the first of what needs you.
  const [picked, setPicked] = useState<string | null>(null);
  const open: string | null =
    picked && items.some((i) => i.key === picked) ? picked : (items[0]?.key ?? null);
  const item = open ? items.find((i) => i.key === open) : undefined;
  // Up next: everything waiting but the open one (a put-off item too, at the end).
  const upNext = items.filter((i) => i.key !== open);
  // The progress ticks: what's done, then what's open, then what's next.
  const total = done.length + items.length;
  const position = done.length + (item ? items.indexOf(item) : 0);

  const [showAllHappened, setShowAllHappened] = useState(false);
  const happened = useMemo(
    () => agents.filter((a) => !a.hidden && a.unread > 0 && !all.some((i) => i.agent.id === a.id)),
    [agents, all]
  );

  const move = useCallback(
    (by: number) => {
      const keys = items.map((i) => i.key);
      if (keys.length === 0) return;
      const at = Math.max(0, keys.indexOf(open ?? ''));
      setPicked(keys[Math.min(keys.length - 1, Math.max(0, at + by))]);
    },
    [items, open]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') return onClose();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'j') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        move(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, move]);

  return (
    <div className="agents-catchup">
      <header className="agents-catchup__head">
        <h2 className="agents-catchup__title">{CATCH_UP.title}</h2>
        <span className="agents-catchup__grow" />
        <Button tabIndex={0} variant="ghost" size="compact" onClick={onOpenInFlight}>
          {CATCH_UP.whatsInFlight}
        </Button>
        <Button
          tabIndex={0}
          variant="ghost"
          size="compact"
          onClick={onClose}
          aria-keyshortcuts="Escape"
        >
          {CATCH_UP.close} <kbd aria-hidden="true">esc</kbd>
        </Button>
      </header>
      <div className="agents-catchup__column">
        {item ? (
          <>
            {total > 1 && (
              <div className="agents-catchup__progress" aria-label={`${position + 1} of ${total}`}>
                <span className="agents-catchup__ticks" aria-hidden="true">
                  {Array.from({ length: total }, (_, i) => (
                    <span
                      key={i}
                      className="agents-catchup__tick"
                      data-current={i === position || undefined}
                      data-done={i < position || undefined}
                    />
                  ))}
                </span>
                <span className="agents-catchup__count">{`${position + 1} of ${total}`}</span>
              </div>
            )}
            <Decision
              key={item.key}
              item={item}
              onOpenChat={() =>
                item.message
                  ? onOpenMessage(item.agent.id, item.message.id, item.message.conversation)
                  : onOpenAgent(item.agent.id)
              }
              onLater={() => {
                setLater((l) => [...l.filter((k) => k !== item.key), item.key]);
                setPicked(null);
              }}
            />
          </>
        ) : (
          <AllClear lastDecision={lastDecision} />
        )}
        {upNext.length > 0 && (
          <section className="agents-catchup__section">
            <h3>{`${CATCH_UP.upNext} · ${upNext.length}`}</h3>
            {upNext.map((i) => (
              <Row
                key={i.key}
                lead={
                  <AgentKey id={i.agent.id} name={i.agent.name} color={i.agent.color} size="md" />
                }
                title={headline(i)}
                sub={`${i.agent.name} · ${later.includes(i.key) ? CATCH_UP.later : CATCH_UP_EYEBROW.needsOk}`}
                right={formatAge(i.ts)}
                onPick={() => setPicked(i.key)}
              />
            ))}
          </section>
        )}
        {happened.length > 0 && (
          <WhileAway
            happened={happened}
            // All clear shows every row; under a decision, three and “Show more”.
            all={!item || showAllHappened}
            onAll={() => setShowAllHappened(true)}
            onOpenAgent={onOpenAgent}
          />
        )}
      </div>
    </div>
  );
}

/** While you were away: a quiet list under the decision, three rows then "Show N more". */
function WhileAway({
  happened,
  all,
  onAll,
  onOpenAgent,
}: {
  happened: Agent[];
  all: boolean;
  onAll: () => void;
  onOpenAgent: (id: string) => void;
}) {
  // Three rows, then “Show N more” (the spec's count).
  const shown = all ? happened : happened.slice(0, 3);
  const rest = happened.length - shown.length;
  return (
    <section className="agents-catchup__section agents-catchup__away">
      <h3>{`${CATCH_UP.whileAway} · ${happened.length}`}</h3>
      {shown.map((a) => (
        <button
          key={a.id}
          type="button"
          tabIndex={0}
          className="agents-catchup__sum-row"
          onClick={() => onOpenAgent(a.id)}
        >
          <AgentKey id={a.id} name={a.name} color={a.color} size="sm" />
          <span className="agents-catchup__sum-text">
            {previewText(a.preview) || 'Something new'}
          </span>
          <span className="agents-catchup__row-right">{clock(a.lastActivityAt)}</span>
        </button>
      ))}
      {rest > 0 && (
        <TextButton tabIndex={0} onClick={onAll} aria-expanded={false}>
          {catchUpMore(rest)}
        </TextButton>
      )}
    </section>
  );
}

/** One row of the queue: a key (or a tile), a title and who, the age at the right. */
function Row({
  lead,
  title,
  sub,
  right,
  selected,
  muted,
  disabled,
  onPick,
}: {
  disabled?: boolean;
  lead: ReactNode;
  title: string;
  sub?: string;
  right?: ReactNode;
  selected?: boolean;
  muted?: boolean;
  onPick?: () => void;
}) {
  const inner = (
    <>
      {lead}
      <span className="agents-catchup__row-text">
        <span className="agents-catchup__row-title">{title}</span>
        {sub && <span className="agents-catchup__row-sub">{sub}</span>}
      </span>
      {right && <span className="agents-catchup__row-right">{right}</span>}
    </>
  );
  const cls = `agents-catchup__row${selected ? ' is-selected' : ''}${muted ? ' is-muted' : ''}`;
  return onPick ? (
    <button
      type="button"
      tabIndex={0}
      className={cls}
      aria-current={selected || undefined}
      disabled={disabled}
      onClick={onPick}
    >
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

/** The thing being approved, as the mock shows it: a recessed panel of field rows
 *  (recipients as chips, From, Subject) and the message's first lines, then “Read all”. */
function Preview({
  draft,
  approval,
}: {
  draft: NonNullable<ReturnType<typeof draftOf>>;
  approval: Approval | undefined;
}) {
  const recipients = [draft.to, ...draft.cc.split(',').map((c) => c.trim())].filter(Boolean);
  const shown = recipients.slice(0, 2);
  const more = recipients.length - shown.length;
  const words = draft.body.trim().split(/\s+/).filter(Boolean).length;
  return (
    <div className="agents-catchup__preview">
      <div className="agents-catchup__field">
        <span className="agents-catchup__field-label">To</span>
        <span className="agents-catchup__chips">
          {shown.map((r) => (
            <span key={r} className="agents-catchup__chip">
              {r}
            </span>
          ))}
          {more > 0 && <span className="agents-catchup__chip-more">+{more} more</span>}
        </span>
      </div>
      {approval?.sendFrom && (
        <div className="agents-catchup__field">
          <span className="agents-catchup__field-label">From</span>
          <span className="agents-catchup__field-value">{approval.sendFrom}</span>
        </div>
      )}
      {draft.subject && (
        <div className="agents-catchup__field">
          <span className="agents-catchup__field-label">Subject</span>
          <span className="agents-catchup__field-value">{draft.subject}</span>
        </div>
      )}
      <p className="agents-catchup__excerpt">{draft.body}</p>
      <span className="agents-catchup__read-all">{`Read all ${words} words`}</span>
    </div>
  );
}

export function Decision({
  item,
  onOpenChat,
  onLater,
}: {
  item: CatchItem;
  onOpenChat: () => void;
  onLater: () => void;
}) {
  const { agent, message } = item;
  const approval = message?.approval;
  const here = answersHere(message);
  const { armed, guard, keyProps } = useCardGuard(here);
  const { showToast } = useOptionalToast();
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLElement>(null);
  const draft = draftOf(approval);
  // The card has focus from the moment it lands, so its keys work at once.
  useEffect(() => card.current?.focus(), []);

  const answer = useCallback(
    async (allow: boolean) => {
      if (!approval || busy) return;
      setBusy(true);
      try {
        await answerApproval(agent.id, approval.requestId, allow);
      } catch (e) {
        showToast(formatCommandError(asCommandError(e)), 'error');
      } finally {
        setBusy(false);
      }
    },
    [agent.id, approval, busy, showToast]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    // A key this card owns is the card's, even when it does nothing yet (Allow
    // not armed): left to bubble, the same letter also opened the agent whose
    // key it is (useAgentKeyShortcuts skips a handled press).
    const claim = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const k = approvalKey(e.nativeEvent);
    if (here && k) {
      claim();
      if (k === 'deny') void answer(false);
      else if (armed) void answer(true);
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat) {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea')) return;
      const key = e.key.toLowerCase();
      if (key === 'o') {
        claim();
        onOpenChat();
      } else if (key === 'l') {
        claim();
        onLater();
      }
    }
  };

  return (
    <article
      ref={card}
      tabIndex={-1}
      className="agents-catchup__card"
      aria-label={`${agent.name}: ${headline(item)}`}
      onKeyDown={onKeyDown}
    >
      <div className="agents-catchup__who">
        <AgentKey
          id={agent.id}
          name={agent.name}
          color={agent.color}
          state={agentKeyState(agent, false)}
          size="md"
        />
        <span className="agents-catchup__name">{agent.name}</span>
        <span className="agents-catchup__ago">{formatAgo(item.ts)}</span>
      </div>
      <p className="agents-catchup__eyebrow">
        <span className="agents-catchup__dot" aria-hidden="true" />
        {kindOf(message)}
      </p>
      <h3 className="agents-catchup__ask">{headline(item)}</h3>
      {why(item) && <p className="agents-catchup__why">{why(item)}</p>}
      {draft && <Preview draft={draft} approval={approval} />}
      <div className="agents-catchup__actions">
        {here ? (
          <>
            <Button
              tabIndex={0}
              variant="strong"
              width="fill"
              data-allow
              disabled={busy}
              {...keyProps}
              onClick={guard(() => void answer(true))}
              aria-keyshortcuts="A"
            >
              {CATCH_UP.allow} <kbd>A</kbd>
            </Button>
            <Button
              tabIndex={0}
              variant="secondary"
              width="fill"
              disabled={busy}
              onClick={() => void answer(false)}
              aria-keyshortcuts="D"
            >
              {CATCH_UP.deny} <kbd>D</kbd>
            </Button>
          </>
        ) : (
          <Button
            tabIndex={0}
            variant="strong"
            width="fill"
            onClick={onOpenChat}
            aria-keyshortcuts="O"
          >
            {CATCH_UP.openChat} <kbd>O</kbd>
          </Button>
        )}
        <span className="agents-catchup__grow" />
        {here && (
          <Button
            tabIndex={0}
            variant="ghost"
            size="compact"
            onClick={onOpenChat}
            aria-keyshortcuts="O"
          >
            {CATCH_UP.openChat} <kbd>O</kbd>
          </Button>
        )}
        <Button tabIndex={0} variant="ghost" size="compact" onClick={onLater} aria-keyshortcuts="L">
          {CATCH_UP.later} <kbd>L</kbd>
        </Button>
      </div>
    </article>
  );
}

function AllClear({ lastDecision }: { lastDecision?: string }) {
  return (
    <section className="agents-catchup__clear" tabIndex={-1}>
      <span className="agents-catchup__ring" aria-hidden="true">
        <CheckIcon size={22} />
      </span>
      <h3>{CATCH_UP.allClear}</h3>
      <p>{catchUpAllClearBody(lastDecision)}</p>
    </section>
  );
}
