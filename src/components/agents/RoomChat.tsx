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
  type ClipboardEvent as ReactClipboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { guardRow } from './AgentsErrorBoundary';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CollaboratorsIcon,
  MicrophoneIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
} from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextArea } from '../primitives/TextField';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { BellIcon, BellOffIcon, CloseIcon, EditIcon, TrashIcon } from '@/components/icons';
import { CompactModeToggle } from '../workspace/ModeToggle';
import { AgentKey } from './AgentKey';
import { RoomAvatars, type RoomActions } from './AgentRoomParts';
import { ConversationBar, ConversationBars } from './AgentCard';
import { tintMentionsIn, useMentionPicker } from './AgentMentions';
import { useDictation } from './useDictation';
import { ComposerAttachments } from './AgentAttachments';
import {
  toOutgoing,
  useComposerAttachments,
  useFileDrop,
  type DraftAttachment,
} from './useComposerAttachments';
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
import { ChangeCard, useAgentProjects } from './AgentProject';
import { SessionCard } from './AgentSession';
import {
  answerApproval,
  buildChatItems,
  engineIsReady,
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
  askedLine,
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
import { composerDraft, setComposerDraft, useComposerDraft } from '../../lib/composerDraft';
import { accentScopeProps, useAccentScope } from '../../lib/accent';
import { blockedCopy, dictationVocabulary, openPrivacySettings } from '../../lib/dictation';
import { listProjects } from '../../lib/project';
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
  /** Files still being copied in: shown as staged, "Sending…", until it lands. */
  files?: DraftAttachment[];
}

interface RoomChatProps extends RoomActions {
  room: Room;
  agentsById: Map<string, Agent>;
  onOpenAgent: (key: string) => void;
  compact?: { agents: Agent[]; onGoHome: () => void; onGoProjects: () => void };
}

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
  // The draft lives outside this component (`composerDraft`): typing
  // re-renders the composer below, never the room.
  const draftKey = `room:${room.id}`;
  const setDraft = useCallback(
    (next: string | ((d: string) => string)) =>
      setComposerDraft(draftKey, typeof next === 'function' ? next(composerDraft(draftKey)) : next),
    [draftKey]
  );
  const [pending, setPending] = useState<Pending[]>([]);
  /** Nobody named and no lead: who should answer, asked above the composer. */
  const [asking, setAsking] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const sectionRef = useRef<HTMLElement>(null);

  // Files and dictation, as in an agent's own chat: there while any engine
  // here can run a turn.
  const engineReady = useAgentsSelector((s) =>
    s.engines.length > 0
      ? s.engines.some((e) => engineIsReady(e.id, s.engines, s.engineReady))
      : s.engineReady
  );
  const toastError = useCallback((message: string) => showToast(message, 'error'), [showToast]);
  const attachments = useComposerAttachments(toastError);
  const staged = attachments.items;
  const { over: dropping, dom: dropHandlers } = useFileDrop(
    sectionRef,
    engineReady,
    (paths) => void attachments.addPaths(paths),
    attachments.addFiles
  );
  const { pick } = attachments;
  const pickFiles = useCallback(() => {
    pick().catch((error: unknown) => toastError(String(error)));
  }, [pick, toastError]);
  const getDraft = useCallback(() => composerDraft(draftKey), [draftKey]);
  const getVocabulary = useCallback(
    async () =>
      dictationVocabulary(
        [...agentsById.values()].map((a) => a.name),
        (await listProjects().catch(() => [])).map((p) => p.name)
      ),
    [agentsById]
  );
  const micRef = useRef<HTMLButtonElement>(null);
  const dictation = useDictation({
    getDraft,
    setDraft,
    getVocabulary,
    meterRef: micRef,
    enabled: engineReady,
  });
  const dictating = dictation.phase !== 'idle';
  const blocked = dictation.blocked ? blockedCopy(dictation.blocked) : null;

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, [room.id]);

  // Your messages show at once; the stored one takes over the same row.
  const { shown, aliases, failed, sending } = useMemo(() => {
    const list = messages ?? [];
    const aliases = new Map<string, string>();
    const failed = new Set<string>();
    const sending = new Map<string, DraftAttachment[]>();
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
      else if (p.files) sending.set(p.key, p.files);
    }
    const streaming = drafts
      .filter((d) => d.text.trim() && !list.some((m) => m.id === d.id))
      .map((d) => ({ ...d, room: room.id }));
    return { shown: [...list, ...local, ...streaming], aliases, failed, sending };
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

  /** Files are copied into the members' homes first; a failure puts everything back. */
  const deliverWithFiles = async (
    entry: Pending,
    files: DraftAttachment[],
    mentionIds: string[],
    everyone: boolean
  ) => {
    try {
      const outgoing = await toOutgoing(files);
      const sent = await sendRoomMessage(room.id, entry.text, mentionIds, everyone, outgoing);
      setPending((list) =>
        list.map((p) => (p.key === entry.key ? { ...p, id: sent.message.id, files: undefined } : p))
      );
      upsertMessage(sent.message);
    } catch (error) {
      setPending((list) => list.filter((p) => p.key !== entry.key));
      setDraft(entry.text);
      attachments.setItems(files);
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  /** Send what's typed to `target`, or to whoever it names. */
  const send = (target?: Addressed) => {
    const text = composerDraft(draftKey).trim();
    if ((!text && staged.length === 0) || members.length === 0 || dictating) return;
    const aim = target ?? addressed(text, members, room.lead);
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
      ...(staged.length > 0 ? { files: staged } : {}),
    };
    setPending((list) => [...list, entry]);
    setDraft('');
    atBottomRef.current = true;
    const mentionIds = aim.kind === 'lead' ? [] : ids;
    if (staged.length > 0) {
      attachments.setItems([]);
      void deliverWithFiles(entry, staged, mentionIds, aim.kind === 'everyone');
    } else {
      void deliver(entry, mentionIds, aim.kind === 'everyone');
    }
  };

  const stop = () =>
    void stopRoom(room.id).catch((error: unknown) =>
      showToast(formatCommandError(asCommandError(error)), 'error')
    );

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

  const rowFor = (item: (typeof items)[number], index: number): ReactElement | ReactElement[] => {
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
              sending={sending.get(m.id)}
            />
          )}
          {m.mentions && m.mentions.length > 0 && (
            <span className="agent-room__to">{askedLine(m.mentions, room.members)}</span>
          )}
        </div>
      );
    }
    if (!m.agentId) {
      // The room's own note about a member ("Finance was stopped before
      // answering.") reads as that member's: its name in its colour.
      const about =
        m.kind === 'note'
          ? [...members]
              .sort((a, b) => b.name.length - a.name.length)
              .find((a) => (m.text ?? '').startsWith(`${a.name} `))
          : undefined;
      return about ? (
        <MemberNote key={m.id} m={m} speaker={about} arrived={arrived} theme={theme} />
      ) : (
        <NoteLine key={m.id} message={m} arrived={arrived} />
      );
    }
    const speaker = agentsById.get(m.agentId);
    // "Acme Site stopped before finishing its reply." is about the room, like
    // "Finance was stopped before answering.": one centred line, its name in
    // its colour, never a speaker block repeating the name.
    if (m.kind === 'note' && !m.work && speaker) {
      return <MemberNote key={m.id} m={m} speaker={speaker} arrived={arrived} theme={theme} />;
    }
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
          members={members}
        />
      </SpeakerBlock>
    );
  };
  // Each line in its own boundary, as in a one-to-one chat: one that fails to
  // draw is one muted line, the rest of the room still shows.
  const rows = items.map((item, index) => {
    const row = rowFor(item, index);
    return Array.isArray(row) ? row.map(guardRow) : guardRow(row);
  });

  // Replying here and nothing typed: the send button is Stop, as in a 1:1 chat.
  const replying = working.length > 0 || waiting.length > 0;
  const memberNames = listNames(members.map((m) => m.name));
  const memberLine =
    room.lead && agentsById.get(room.lead)
      ? `${memberNames} · ${agentsById.get(room.lead)!.name} answers unless you @ someone`
      : memberNames;

  return (
    <AccentScopeProvider scope={accentScope}>
      <section
        ref={sectionRef}
        className="agent-chat agent-room"
        aria-label={`Room ${room.name}`}
        data-dropping={dropping || undefined}
        {...accentScope}
        {...dropHandlers}
      >
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
              {replying && (
                <DropdownItem icon={<CloseIcon size={12} />} onSelect={stop}>
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

        <div
          className="agent-chat__scroll"
          ref={scrollRef}
          onScroll={onScroll}
          tabIndex={0}
          role="region"
          aria-label="Messages"
        >
          <div className="agent-chat__messages" ref={messagesRef}>
            {items.length === 0 && messages !== undefined ? (
              <RoomEmpty
                room={room}
                members={members}
                madeBy={room.createdBy ? agentsById.get(room.createdBy)?.name : undefined}
                onPick={(a) => insertMention(a)}
              />
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
          <ConversationBars
            bars={[
              {
                id: 'dictation',
                node: blocked && (
                  <ConversationBar
                    role="alert"
                    state="waiting"
                    title={blocked.message}
                    actions={
                      <>
                        <TextButton onClick={dictation.dismissBlocked}>Dismiss</TextButton>
                        {blocked.settings && (
                          <Button
                            size="compact"
                            variant="secondary"
                            onClick={() => {
                              const url = blocked.settings;
                              if (url) void openPrivacySettings(url);
                            }}
                          >
                            Open System Settings
                          </Button>
                        )}
                      </>
                    }
                  />
                ),
              },
            ]}
          />
          {members.length < MIN_ROOM_MEMBERS && (
            <ConversationBars
              bars={[
                {
                  id: 'engine',
                  node: (
                    <ConversationBar
                      icon={<CollaboratorsIcon size={14} />}
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
          {asking && (
            <WhoShouldAnswer
              members={members}
              onPick={(target) => send(target)}
              onCancel={() => {
                setAsking(false);
                inputRef.current?.focus();
              }}
            />
          )}
          <RoomComposer
            room={room}
            members={members}
            draftKey={draftKey}
            inputRef={inputRef}
            micRef={micRef}
            dictation={dictation}
            staged={staged}
            attachments={attachments}
            engineReady={engineReady}
            pickFiles={pickFiles}
            asking={asking}
            setAsking={setAsking}
            replying={replying}
            onSend={() => send()}
            onStop={stop}
          />
        </div>

        <div className="agent-chat__drop" aria-hidden={!dropping}>
          <div className="agent-chat__drop-label">
            <span className="agent-chat__drop-icon">
              <PaperclipIcon size={18} />
            </span>
            Drop files for {room.name}
          </div>
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

/**
 * The room's composer: it reads the draft itself (`useComposerDraft`), so a
 * keystroke re-renders this and not the room's conversation above it.
 */
function RoomComposer({
  room,
  members,
  draftKey,
  inputRef,
  micRef,
  dictation,
  staged,
  attachments,
  engineReady,
  pickFiles,
  asking,
  setAsking,
  replying,
  onSend,
  onStop,
}: {
  room: Room;
  members: Agent[];
  draftKey: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  micRef: RefObject<HTMLButtonElement | null>;
  dictation: ReturnType<typeof useDictation>;
  staged: DraftAttachment[];
  attachments: { remove: (id: string) => void; onPaste: (e: ReactClipboardEvent) => void };
  engineReady: boolean;
  pickFiles: () => void;
  asking: boolean;
  setAsking: (v: boolean) => void;
  replying: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  const draft = useComposerDraft(draftKey);
  const setDraft = useCallback((text: string) => setComposerDraft(draftKey, text), [draftKey]);
  const dictating = dictation.phase !== 'idle';
  // @ offers the room's members and @everyone, nobody else.
  const mentionable = useMemo(() => [...members, everyoneEntry(members.length)], [members]);
  const mentionPicker = useMentionPicker(mentionable, inputRef, setDraft);
  const to: Addressed = addressed(draft, members, room.lead);
  // Quiet while the mention menu is up: who answers is still being picked.
  const toLine =
    (draft.trim() || staged.length > 0) && !mentionPicker.showing ? addressLine(to, members) : null;
  // Nobody left to answer: nothing can be sent until someone is added.
  const canSend = (draft.trim().length > 0 || staged.length > 0) && members.length > 0;
  // Replying here and nothing typed: the send button is Stop, as in a 1:1 chat.
  const showStop = replying && !canSend && !dictating;

  return (
    <form
      className="agent-composer"
      data-dictation={dictation.phase}
      data-has-attachments={staged.length > 0 || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      {mentionPicker.menu}
      <ComposerAttachments items={staged} onRemove={attachments.remove} />
      <TextArea
        ref={inputRef}
        className="agent-composer__input"
        rows={1}
        value={draft}
        placeholder={
          dictating
            ? ''
            : members.length === 1
              ? `Message ${members[0].name}`
              : `Message ${room.name} · @ to pick who answers`
        }
        readOnly={dictating}
        onChange={(e) => {
          setDraft(e.target.value);
          mentionPicker.sync();
          if (asking) setAsking(false);
        }}
        onSelect={mentionPicker.sync}
        onPaste={attachments.onPaste}
        onKeyDown={(e) => {
          if (dictation.onComposerKeyDown(e)) return;
          if (mentionPicker.onKeyDown(e)) return;
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSend();
          } else if (e.key === 'Escape' && asking) {
            e.preventDefault();
            setAsking(false);
          }
        }}
        aria-label={`Message ${room.name}`}
      />
      <div className="agent-composer__bar">
        {dictating ? (
          <span className="agent-composer__listening" role="status">
            <span className="agent-composer__listening-dot" aria-hidden />
            {dictation.phase === 'finishing' ? 'Finishing…' : 'Listening'}
            <span aria-hidden>·</span>
            <TextButton tabIndex={0} onClick={dictation.cancel}>
              Cancel
            </TextButton>
          </span>
        ) : (
          engineReady && (
            <IconButton
              tabIndex={0}
              variant="ghost"
              className="agent-composer__attach"
              icon={<PaperclipIcon size={14} />}
              onClick={pickFiles}
              aria-label="Attach files"
              title="Attach files, or paste or drop them here"
            />
          )
        )}
        {!dictating && (
          <span className="agent-composer__hint agent-room__address" aria-live="polite">
            {toLine ??
              (canSend && to.kind === 'ask' && !asking && !mentionPicker.showing
                ? 'Who should answer? @ someone'
                : '')}
          </span>
        )}
        <div className="agent-composer__actions">
          {engineReady && (
            <IconButton
              ref={micRef}
              tabIndex={0}
              variant="ghost"
              className="agent-composer__mic"
              icon={<MicrophoneIcon size={14} />}
              onClick={dictation.toggle}
              disabled={dictation.phase === 'finishing'}
              aria-pressed={dictating}
              aria-label={dictating ? 'Stop dictating' : 'Dictate'}
              title={
                dictating ? 'Stop dictating (Esc to discard)' : 'Dictate (⌘⇧D, or hold ⌥Space)'
              }
            />
          )}
          {showStop ? (
            <IconButton
              tabIndex={0}
              variant="secondary"
              className="agent-composer__stop"
              icon={<span className="agent-composer__stop-square" aria-hidden />}
              onClick={onStop}
              aria-label={`Stop replies in ${room.name}`}
              title="Stop replies here"
            />
          ) : (
            <IconButton
              tabIndex={0}
              type="submit"
              variant={canSend && !dictating ? 'primary' : 'secondary'}
              className="agent-composer__send"
              icon={<ArrowUpIcon size={14} />}
              disabled={!canSend || dictating}
              aria-label="Send"
              title="Send"
            />
          )}
        </div>
      </div>
    </form>
  );
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
          <AgentKey
            id={speaker?.id}
            name={speaker?.name ?? '?'}
            color={speaker?.color ?? 'gray'}
            size="sm"
          />
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
  members,
}: {
  m: AgentMessage;
  speaker: Agent | undefined;
  /** The room's members: an @ of one of them in this reply is tinted its colour. */
  members: Agent[];
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
  const projectsCtx = useAgentProjects();
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
            onPreview={projectsCtx?.openProject}
            arrived={arrived}
          />
        );
      }
      return (
        <TintedMentions text={m.text} members={members} author={speaker.id}>
          <AgentBubble message={m} agent={speaker} arrived={arrived} streaming={streaming} />
        </TintedMentions>
      );
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

/**
 * A member's @mention of another member, tinted in that member's colour, as
 * your own are: a hand-off is the point of a room. The prose is sanitized
 * HTML, so the names are wrapped in its text nodes after it renders.
 */
function TintedMentions({
  text,
  members,
  author,
  children,
}: {
  text: string;
  members: Agent[];
  author: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const others = useMemo(() => members.filter((m) => m.id !== author), [members, author]);
  useLayoutEffect(() => {
    const prose = ref.current?.querySelectorAll<HTMLElement>('.agent-markdown__prose');
    prose?.forEach((el) => tintMentionsIn(el, others));
  }, [text, others]);
  return (
    <div ref={ref} className="agent-room__prose">
      {children}
    </div>
  );
}

/** A member's own note in the room: the room's centred line, its name in its colour. */
function MemberNote({
  m,
  speaker,
  arrived,
  theme,
}: {
  m: AgentMessage;
  speaker: Agent;
  arrived: boolean;
  theme: ReturnType<typeof useResolvedTheme>;
}) {
  const scope = useMemo(() => accentScopeProps(speaker.color, theme), [speaker.color, theme]);
  const at = m.text.indexOf(speaker.name);
  return (
    <div
      className="agent-note agent-room__member-note"
      data-arrived={arrived || undefined}
      data-message-ids={m.id}
      {...scope}
    >
      {at < 0 ? (
        m.text
      ) : (
        <>
          {m.text.slice(0, at)}
          <span className="agent-mention" data-color={speaker.color}>
            {speaker.name}
          </span>
          {m.text.slice(at + speaker.name.length)}
        </>
      )}
    </div>
  );
}

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
        {/* Its key cap looks around here; the line under it doesn't repeat it. */}
        <AgentKey id={agent.id} name={agent.name} color={agent.color} state="working" size="sm" />
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
            <AgentKey id={m.id} name={m.name} color={m.color} size="sm" />
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
  madeBy,
  onPick,
}: {
  room: Room;
  members: Agent[];
  /** The agent that made it (the Chief's `create_room`), when one did. */
  madeBy?: string;
  onPick: (agent: Agent) => void;
}) {
  const lead = members.find((m) => m.id === room.lead);
  return (
    <div className="agent-chat__empty agent-room__empty">
      <RoomAvatars members={members} />
      <p className="agent-chat__empty-name">{room.name}</p>
      {room.purpose && <p className="agent-chat__empty-role">{room.purpose}</p>}
      <p className="agent-chat__empty-role">
        {lead
          ? `Talk to everyone here at once. ${lead.name} answers unless you @ someone; @everyone asks all ${members.length}.`
          : `Talk to everyone here at once. @ who should answer, or @everyone to ask all ${members.length}.`}
      </p>
      <p className="agent-chat__empty-hint">
        {madeBy && `${madeBy} made this room. `}Each agent keeps its own memory, and remembers what
        it says here in its own chat too.
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
