/**
 * A room: one thread shared by you and two to six agents.
 *
 * The room itself is neutral (the monochrome accent); each agent's lines
 * carry its own colour, under its name, so who said what reads at a glance.
 * Your message goes to the agents you @mention, everyone for @everyone, or
 * the room's lead; with none of those the composer asks "Who should
 * answer?" instead of guessing. The foot line under the composer always says
 * who will answer before you send.
 *
 * Each agent answers from its own session, shown the room's recent lines.
 * Approval cards, timelines and result cards appear inline, under the agent
 * whose turn they belong to, and are answered here as in its own chat.
 *
 * @module components/agents/RoomChat
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowDownIcon, ArrowUpIcon, MoreHorizontalIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextArea } from '../primitives/TextField';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { BellIcon, BellOffIcon, CloseIcon, EditIcon, TrashIcon } from '@/components/icons';
import { CompactModeToggle } from '../workspace/ModeToggle';
import { AgentAvatar } from './AgentAvatar';
import { RoomAvatars, type RoomActions } from './AgentRoomParts';
import { ConversationBar, ConversationBars } from './AgentCard';
import { useMentionPicker } from './AgentMentions';
import { useArrivals, useFollowBottom, usePresence } from './useAgentMotion';
import {
  AgentBubble,
  ApprovalCard,
  DayDivider,
  ErrorLine,
  NoteLine,
  UserBubble,
  WorkingIndicator,
} from './AgentChatItems';
import { ResultCardView } from './AgentResult';
import { ChangeCard } from './AgentProject';
import { SessionCard } from './AgentSession';
import {
  answerApproval,
  buildChatItems,
  newestResults,
  plainActivity,
  type Agent,
  type AgentMessage,
  type AgentRef,
  type ResultRef,
} from '../../lib/agents';
import {
  addressLine,
  addressed,
  everyoneEntry,
  EVERYONE_ID,
  handRevisionTo,
  listNames,
  MIN_ROOM_MEMBERS,
  roomActivity,
  roomKey,
  roomMembers,
  sendRoomMessage,
  stopRoom,
  turnsLine,
  type Addressed,
  type Room,
} from '../../lib/agentRooms';
import { loadOlderRoomMessages, upsertMessage, useAgentsSelector } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { accentScopeProps, useAccentScope } from '../../lib/accent';
import { useResolvedTheme } from '../../lib/theme';
import { AccentScopeProvider } from '../../contexts/AccentScopeContext';

const STICK_THRESHOLD = 80;

interface Pending {
  key: string;
  id?: string;
  text: string;
  ts: number;
  mentions: AgentRef[];
  failed?: boolean;
}

interface RoomChatProps extends RoomActions {
  room: Room;
  agentsById: Map<string, Agent>;
  onOpenAgent: (key: string) => void;
  compact?: { agents: Agent[]; onGoHome: () => void; onGoProjects: () => void };
}

/** What you were typing in each room, kept across a trip to a project. */
const unsentText = new Map<string, string>();

export function RoomChat({
  room,
  agentsById,
  onOpenAgent,
  compact,
  onEditRoom,
  onToggleRoomMuted,
  onDeleteRoom,
}: RoomChatProps) {
  // Neutral: a room has no one agent's colour. Each member's lines carry theirs.
  const accentScope = useAccentScope('white');
  const theme = useResolvedTheme();
  const key = roomKey(room.id);
  const messages = useAgentsSelector((s) => s.messages[key]);
  const hasOlder = useAgentsSelector((s) => s.older[key] ?? false);
  const members = useMemo(() => roomMembers(room, agentsById), [room, agentsById]);
  const { working, waiting } = roomActivity(room, members);
  const workingKey = working.map((a) => a.id).join(' ');
  // Replies streaming in this room: each working member's draft.
  const drafts = useAgentsSelector(
    (s) => working.map((a) => s.drafts[a.id]).filter(Boolean),
    (a, b) => a.length === b.length && a.every((d, i) => d === b[i])
  );
  const { showToast } = useOptionalToast();
  const [draft, setDraft] = useState(() => unsentText.get(room.id) ?? '');
  useEffect(() => {
    if (draft) unsentText.set(room.id, draft);
    else unsentText.delete(room.id);
  }, [room.id, draft]);
  const [pending, setPending] = useState<Pending[]>([]);
  /** Nobody named and no lead: who should answer, asked above the composer. */
  const [asking, setAsking] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // @ offers the room's members and @everyone, nobody else.
  const mentionable = useMemo(() => [...members, everyoneEntry(members.length)], [members]);
  const mentionPicker = useMentionPicker(mentionable, inputRef, setDraft);
  const to: Addressed = addressed(draft, members, room.lead);
  const toLine = draft.trim() ? addressLine(to, members) : null;

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, [room.id]);

  // Your messages show at once; the stored one takes over the same row.
  const { shown, aliases, failed } = useMemo(() => {
    const list = messages ?? [];
    const aliases = new Map<string, string>();
    const failed = new Set<string>();
    const local: AgentMessage[] = [];
    for (const p of pending) {
      const match =
        list.find((m) => m.id === p.id) ??
        list.find(
          (m) => m.kind === 'user' && m.text === p.text && m.ts >= p.ts - 5000 && !aliases.has(m.id)
        );
      if (match) {
        aliases.set(match.id, p.key);
        continue;
      }
      local.push({
        id: p.key,
        agentId: '',
        ts: p.ts,
        kind: 'user',
        text: p.text,
        mentions: p.mentions,
        room: room.id,
      });
      if (p.failed) failed.add(p.key);
    }
    const streaming = drafts
      .filter((d) => d.text.trim() && !list.some((m) => m.id === d.id))
      .map((d) => ({ ...d, room: room.id }));
    return { shown: [...list, ...local, ...streaming], aliases, failed };
  }, [messages, pending, drafts, room.id]);

  // Room lines never fold here: this is the room.
  const items = useMemo(() => buildChatItems(shown.map(({ room: _room, ...m }) => m)), [shown]);
  const ids = useMemo(() => messages?.map((m) => m.id), [messages]);
  const isArrived = useArrivals(ids);
  // Each member's open copy of its project: the newest card here for it
  // offers Keep / Discard, as in that member's own chat.
  const liveCopyCards = useMemo(() => {
    const live = new Set<string>();
    for (const member of members) {
      const copyId = member.copy?.id;
      if (!copyId) continue;
      for (let i = shown.length - 1; i >= 0; i--) {
        const m = shown[i];
        if (m.agentId === member.id && m.kind === 'changes' && m.changes?.copy?.id === copyId) {
          live.add(m.id);
          break;
        }
      }
    }
    return live;
  }, [shown, members]);
  // Each result's newest version is drawn in full; older ones fold.
  const newestResult = useMemo(() => new Set(newestResults(shown).values()), [shown]);
  // A room message can't revise a result: the member's own chat opens with
  // the request staged in its composer.
  const askForChanges = useCallback(
    (agentId: string, ref: ResultRef) => {
      handRevisionTo(agentId, ref);
      onOpenAgent(agentId);
    },
    [onOpenAgent]
  );
  const indicator = usePresence(working.length > 0 || waiting.length > 0);
  const jump = usePresence(!atBottom);
  const { follow, isGliding } = useFollowBottom(scrollRef, messagesRef, atBottomRef);
  const lastId = shown[shown.length - 1]?.id ?? '';
  const lastIdRef = useRef(lastId);
  useLayoutEffect(() => {
    const isNew = lastIdRef.current !== lastId;
    lastIdRef.current = lastId;
    if (atBottomRef.current) follow(isNew && isArrived(lastId));
  }, [lastId, shown, workingKey, follow, isArrived]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || isGliding()) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (hasOlder && el.scrollTop < el.clientHeight) void loadOlderRoomMessages(room.id);
  }, [isGliding, hasOlder, room.id]);

  const onAnswer = useCallback(
    (agentId: string) =>
      async (
        requestId: string,
        allow: boolean,
        always?: boolean,
        note?: string,
        choice?: number
      ) => {
        try {
          await answerApproval(agentId, requestId, allow, always, note, choice);
        } catch (error) {
          showToast(formatCommandError(asCommandError(error)), 'error');
        }
      },
    [showToast]
  );

  const deliver = async (entry: Pending, mentionIds: string[], everyone: boolean) => {
    try {
      const sent = await sendRoomMessage(room.id, entry.text, mentionIds, everyone);
      setPending((list) =>
        list.map((p) => (p.key === entry.key ? { ...p, id: sent.message.id } : p))
      );
      upsertMessage(sent.message);
    } catch (error) {
      setPending((list) => list.map((p) => (p.key === entry.key ? { ...p, failed: true } : p)));
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  /** Send what's typed to `target`, or to whoever it names. */
  const send = (target?: Addressed) => {
    const text = draft.trim();
    if (!text || members.length === 0) return;
    const aim = target ?? to;
    if (aim.kind === 'ask') {
      setAsking(true);
      return;
    }
    setAsking(false);
    const ids = aim.kind === 'named' ? aim.ids : aim.kind === 'lead' ? [aim.id] : [];
    const refs = (
      aim.kind === 'everyone' ? members : members.filter((m) => ids.includes(m.id))
    ).map(({ id, name }) => ({ id, name }));
    const entry: Pending = {
      key: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text,
      ts: Date.now(),
      mentions: refs,
    };
    setPending((list) => [...list, entry]);
    setDraft('');
    atBottomRef.current = true;
    void deliver(entry, aim.kind === 'lead' ? [] : ids, aim.kind === 'everyone');
  };

  const retry = (key: string) => {
    const entry = pending.find((p) => p.key === key);
    if (!entry) return;
    setPending((list) => list.map((p) => (p.key === key ? { ...p, failed: false } : p)));
    const everyone = entry.mentions.length === members.length && members.length > 1;
    void deliver(
      { ...entry, failed: false },
      entry.mentions.map((m) => m.id),
      everyone
    );
  };

  // Tints for @mentions in your lines.
  const colorOf = useCallback((id: string) => agentsById.get(id)?.color, [agentsById]);
  const anyMember = members[0];

  const rows = items.map((item, index) => {
    if (item.type === 'day') return <DayDivider key={`day-${item.ts}`} ts={item.ts} />;
    if (item.type !== 'message') {
      // Agent-to-agent lines in a room are each speaker's own: shown as notes.
      return item.messages.map((m) => <SpeakerLine key={m.id} m={m} />);
    }
    const m = item.message;
    const arrived = isArrived(m.id);
    if (m.kind === 'user') {
      return (
        <div key={aliases.get(m.id) ?? m.id} className="agent-room__user">
          {anyMember && (
            <UserBubble
              message={m}
              agent={anyMember}
              arrived={arrived}
              failed={failed.has(m.id)}
              onRetry={retry}
              colorOf={colorOf}
            />
          )}
          {m.mentions && m.mentions.length > 0 && (
            <span className="agent-room__to">To {listNames(m.mentions.map((r) => r.name))}</span>
          )}
        </div>
      );
    }
    if (!m.agentId) return <NoteLine key={m.id} message={m} arrived={arrived} />;
    const speaker = agentsById.get(m.agentId);
    const previous = items[index - 1];
    const sameSpeaker =
      previous?.type === 'message' &&
      previous.message.agentId === m.agentId &&
      previous.message.kind !== 'user';
    return (
      <SpeakerBlock key={m.id} speaker={speaker} showName={!sameSpeaker} theme={theme}>
        <MemberRow
          m={m}
          speaker={speaker}
          arrived={arrived}
          streaming={drafts.some((d) => d.id === m.id)}
          onAnswer={onAnswer(m.agentId)}
          onOpenAgent={onOpenAgent}
          liveCopy={liveCopyCards.has(m.id)}
          newestResult={newestResult.has(m.id)}
          onAskForChanges={askForChanges}
        />
      </SpeakerBlock>
    );
  });

  // Nobody left to answer: nothing can be sent until someone is added.
  const canSend = draft.trim().length > 0 && members.length > 0;
  const memberNames = listNames(members.map((m) => m.name));
  const memberLine =
    room.lead && agentsById.get(room.lead)
      ? `${memberNames} · ${agentsById.get(room.lead)!.name} answers unless you @ someone`
      : memberNames;

  return (
    <AccentScopeProvider scope={accentScope}>
      <section className="agent-chat agent-room" aria-label={`Room ${room.name}`} {...accentScope}>
        <header className="agent-chat__header">
          {compact && (
            <CompactModeToggle
              mode="agents"
              onProjects={compact.onGoProjects}
              className="agent-chat__mode"
            />
          )}
          <div className="agent-chat__title agent-room__title">
            <RoomAvatars members={members} />
            <span className="agent-room__heading">
              <span className="agent-room__name">{room.name}</span>
              <span className="agent-room__members" title={memberLine}>
                {memberLine}
              </span>
            </span>
          </div>
          <div className="agent-chat__actions">
            <Dropdown
              align="right"
              portal
              menuClassName="agent-model-menu"
              className="agent-chat__menu"
              trigger={(p) => (
                <IconButton
                  {...p}
                  tabIndex={0}
                  variant="ghost"
                  icon={<MoreHorizontalIcon size={14} />}
                  title="Room actions"
                  aria-label={`Actions for ${room.name}`}
                />
              )}
            >
              <DropdownItem icon={<EditIcon size={12} />} onSelect={() => onEditRoom(room)}>
                Members and name…
              </DropdownItem>
              <DropdownItem
                icon={room.muted ? <BellIcon size={12} /> : <BellOffIcon size={12} />}
                onSelect={() => onToggleRoomMuted(room)}
              >
                {room.muted ? 'Unmute' : 'Mute'}
              </DropdownItem>
              {(working.length > 0 || waiting.length > 0) && (
                <DropdownItem
                  icon={<CloseIcon size={12} />}
                  onSelect={() =>
                    void stopRoom(room.id).catch((error: unknown) =>
                      showToast(formatCommandError(asCommandError(error)), 'error')
                    )
                  }
                >
                  Stop replies here
                </DropdownItem>
              )}
              <DropdownDivider />
              <DropdownItem
                icon={<TrashIcon size={12} />}
                variant="danger"
                onSelect={() => onDeleteRoom(room)}
              >
                Delete room…
              </DropdownItem>
            </Dropdown>
          </div>
        </header>

        <div className="agent-chat__scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="agent-chat__messages" ref={messagesRef}>
            {items.length === 0 && messages !== undefined ? (
              <RoomEmpty room={room} members={members} onPick={(a) => insertMention(a)} />
            ) : (
              rows
            )}
            {indicator.mounted && (
              <RoomWorking
                room={room}
                working={working}
                waiting={waiting}
                theme={theme}
                entering={indicator.entering}
                leaving={indicator.leaving}
                onExited={indicator.onExited}
              />
            )}
          </div>
        </div>

        <div className="agent-chat__footer">
          {jump.mounted && (
            <IconButton
              tabIndex={0}
              size="compact"
              className="agent-chat__jump"
              data-leaving={jump.leaving || undefined}
              onAnimationEnd={jump.leaving ? jump.onExited : undefined}
              icon={<ArrowDownIcon size={14} />}
              onClick={() =>
                scrollRef.current?.scrollTo({
                  top: scrollRef.current.scrollHeight,
                  behavior: 'smooth',
                })
              }
              aria-label="Jump to latest"
              title="Jump to latest"
            />
          )}
          {members.length < MIN_ROOM_MEMBERS && (
            <ConversationBars
              bars={[
                {
                  id: 'engine',
                  node: (
                    <ConversationBar
                      data-testid="room-too-few"
                      title={
                        members.length === 1
                          ? `Only ${members[0].name} is left in this room`
                          : 'Nobody is left in this room'
                      }
                      detail="A room needs two members. Add someone, or delete it."
                      actions={
                        <>
                          <Button
                            tabIndex={0}
                            size="compact"
                            variant="secondary"
                            onClick={() => onDeleteRoom(room)}
                          >
                            Delete room
                          </Button>
                          <Button
                            tabIndex={0}
                            size="compact"
                            variant="strong"
                            onClick={() => onEditRoom(room)}
                          >
                            Add members
                          </Button>
                        </>
                      }
                    />
                  ),
                },
              ]}
            />
          )}
          {asking && canSend && (
            <WhoShouldAnswer
              members={members}
              onPick={(target) => send(target)}
              onCancel={() => {
                setAsking(false);
                inputRef.current?.focus();
              }}
            />
          )}
          <form
            className="agent-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            {mentionPicker.menu}
            <TextArea
              ref={inputRef}
              className="agent-composer__input"
              rows={1}
              value={draft}
              placeholder={`Message ${room.name} · @ to pick who answers`}
              onChange={(e) => {
                setDraft(e.target.value);
                mentionPicker.sync();
                if (asking) setAsking(false);
              }}
              onSelect={mentionPicker.sync}
              onKeyDown={(e) => {
                if (mentionPicker.onKeyDown(e)) return;
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                } else if (e.key === 'Escape' && asking) {
                  e.preventDefault();
                  setAsking(false);
                }
              }}
              aria-label={`Message ${room.name}`}
            />
            <div className="agent-composer__bar">
              <span className="agent-composer__hint agent-room__address" aria-live="polite">
                {toLine ??
                  (canSend && to.kind === 'ask' && !asking ? 'Who should answer? @ someone' : '')}
              </span>
              <div className="agent-composer__actions">
                <IconButton
                  tabIndex={0}
                  type="submit"
                  variant={canSend ? 'primary' : 'secondary'}
                  className="agent-composer__send"
                  icon={<ArrowUpIcon size={14} />}
                  disabled={!canSend}
                  aria-label="Send"
                  title="Send"
                />
              </div>
            </div>
          </form>
        </div>
      </section>
    </AccentScopeProvider>
  );

  function insertMention(agent: Agent) {
    const text = `@${agent.name} `;
    setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text));
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }
}

/** A run of one agent's lines, in its colour, under its name once. */
function SpeakerBlock({
  speaker,
  showName,
  theme,
  children,
}: {
  speaker: Agent | undefined;
  showName: boolean;
  theme: ReturnType<typeof useResolvedTheme>;
  children: ReactNode;
}) {
  const scope = useMemo(
    () => accentScopeProps(speaker?.color ?? 'gray', theme),
    [speaker?.color, theme]
  );
  return (
    <div className="agent-room__speaker" data-continued={!showName || undefined} {...scope}>
      {showName && (
        <div className="agent-room__speaker-name" data-color={speaker?.color ?? 'gray'}>
          <AgentAvatar name={speaker?.name ?? '?'} color={speaker?.color ?? 'gray'} size="mini" />
          <span>{speaker?.name ?? 'A former member'}</span>
        </div>
      )}
      {children}
    </div>
  );
}

/** One member's line, drawn the way its own chat draws it. */
const MemberRow = memo(function MemberRow({
  m,
  speaker,
  arrived,
  streaming,
  onAnswer,
  onOpenAgent,
  liveCopy,
  newestResult,
  onAskForChanges,
}: {
  m: AgentMessage;
  speaker: Agent | undefined;
  arrived: boolean;
  streaming: boolean;
  /** The newest card for the member's open copy: it offers Keep / Discard. */
  liveCopy: boolean;
  /** The newest version of its result: drawn in full, with its actions. */
  newestResult: boolean;
  onAskForChanges: (agentId: string, ref: ResultRef) => void;
  onAnswer: (
    requestId: string,
    allow: boolean,
    always?: boolean,
    note?: string,
    choice?: number
  ) => Promise<void>;
  onOpenAgent: (key: string) => void;
}) {
  if (!speaker) {
    // A member deleted since: what it said stays, as plain text.
    return m.text ? <div className="agent-note">{m.text}</div> : null;
  }
  const askForChanges = (ref: ResultRef) => onAskForChanges(speaker.id, ref);
  switch (m.kind) {
    case 'agent':
      if (m.result) {
        return (
          <ResultCardView
            message={m}
            card={m.result}
            agent={speaker}
            newest={newestResult}
            onAskForChanges={askForChanges}
            arrived={arrived}
          />
        );
      }
      return <AgentBubble message={m} agent={speaker} arrived={arrived} streaming={streaming} />;
    case 'approval':
      return (
        <ApprovalCard
          message={m}
          agentName={speaker.name}
          paused={speaker.status.state === 'idle'}
          onAnswer={onAnswer}
          arrived={arrived}
        />
      );
    case 'error':
      return <ErrorLine message={m} arrived={arrived} agent={speaker} engine={speaker.engine} />;
    case 'note':
      return <NoteLine message={m} arrived={arrived} agent={speaker} onOpenPeer={onOpenAgent} />;
    case 'changes':
      return (
        <ChangeCard
          message={m}
          arrived={arrived}
          agent={liveCopy ? speaker : undefined}
          live={liveCopy}
          owner={speaker}
          newestResult={newestResult}
          onAskForChanges={askForChanges}
        />
      );
    case 'session':
      return <SessionCard message={m} agent={speaker} arrived={arrived} />;
    case 'sent_to_agent':
    case 'from_agent':
      return <SpeakerLine m={m} />;
    default:
      return null;
  }
});

/** "Messaged Ops": an agent handing work on outside the room. */
function SpeakerLine({ m }: { m: AgentMessage }) {
  if (!m.peer) return null;
  return (
    <div className="agent-note" data-message-ids={m.id}>
      {m.kind === 'sent_to_agent' ? `Messaged ${m.peer.name}` : `Message from ${m.peer.name}`}
    </div>
  );
}

/** Who's replying here, each in its colour, and how much of this message's budget is spent. */
function RoomWorking({
  room,
  working,
  waiting,
  theme,
  entering,
  leaving,
  onExited,
}: {
  room: Room;
  working: Agent[];
  waiting: Agent[];
  theme: ReturnType<typeof useResolvedTheme>;
  entering?: boolean;
  leaving?: boolean;
  onExited?: () => void;
}) {
  return (
    <div
      className="agent-room__working"
      data-entering={entering || undefined}
      data-leaving={leaving || undefined}
      onAnimationEnd={(e) => {
        if (leaving && e.target === e.currentTarget) onExited?.();
      }}
    >
      {working
        .filter((a) => a.status.state === 'working')
        .map((a) => (
          <WorkingFor key={a.id} agent={a} theme={theme} />
        ))}
      {waiting.length > 0 && (
        <div className="agent-note agent-room__waiting">
          {listNames(waiting.map((a) => a.name))} will reply after{' '}
          {waiting.length === 1 ? 'what it’s doing now' : 'what they’re doing now'}
        </div>
      )}
      {room.turnsUsed > 1 && <div className="agent-room__turns">{turnsLine(room)}</div>}
    </div>
  );
}

function WorkingFor({
  agent,
  theme,
}: {
  agent: Agent;
  theme: ReturnType<typeof useResolvedTheme>;
}) {
  const scope = useMemo(() => accentScopeProps(agent.color, theme), [agent.color, theme]);
  return (
    <div className="agent-room__speaker" {...scope}>
      <div className="agent-room__speaker-name" data-color={agent.color}>
        <AgentAvatar name={agent.name} color={agent.color} size="mini" />
        <span>{agent.name}</span>
      </div>
      <WorkingIndicator
        activity={
          agent.status.state === 'waiting'
            ? 'Waiting for your OK'
            : plainActivity(agent.status.activity)
        }
        work={agent.status.work}
        agent={agent}
      />
    </div>
  );
}

/** Nobody named and no lead: pick who answers, or everyone. */
function WhoShouldAnswer({
  members,
  onPick,
  onCancel,
}: {
  members: Agent[];
  onPick: (target: Addressed) => void;
  onCancel: () => void;
}) {
  return (
    <div className="agent-room__ask" role="group" aria-label="Who should answer?">
      <span className="agent-room__ask-title">Who should answer?</span>
      <div className="agent-room__ask-choices">
        {members.map((m) => (
          <Button
            key={m.id}
            size="compact"
            variant="secondary"
            onClick={() => onPick({ kind: 'named', ids: [m.id] })}
          >
            <AgentAvatar name={m.name} color={m.color} size="mini" />
            {m.name}
          </Button>
        ))}
        <Button size="compact" variant="secondary" onClick={() => onPick({ kind: 'everyone' })}>
          Everyone
        </Button>
        <Button size="compact" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A new room: who's here, and how to talk to them. */
function RoomEmpty({
  room,
  members,
  onPick,
}: {
  room: Room;
  members: Agent[];
  onPick: (agent: Agent) => void;
}) {
  const lead = members.find((m) => m.id === room.lead);
  return (
    <div className="agent-chat__empty agent-room__empty">
      <RoomAvatars members={members} size="wide" />
      <p className="agent-chat__empty-name">{room.name}</p>
      <p className="agent-chat__empty-role">
        {lead
          ? `Talk to everyone here at once. ${lead.name} answers unless you @ someone; @everyone asks all ${members.length}.`
          : `Talk to everyone here at once. @ who should answer, or @everyone to ask all ${members.length}.`}
      </p>
      <p className="agent-chat__empty-hint">
        Each agent keeps its own memory, and sees the room’s recent messages when it’s asked.
      </p>
      <div className="agent-chat__starters">
        {members.map((m) => (
          <Button key={m.id} tabIndex={0} variant="secondary" onClick={() => onPick(m)}>
            @{m.name}
          </Button>
        ))}
        <Button
          tabIndex={0}
          variant="secondary"
          onClick={() => onPick({ ...everyoneEntry(members.length), id: EVERYONE_ID })}
        >
          @everyone
        </Button>
      </div>
    </div>
  );
}
