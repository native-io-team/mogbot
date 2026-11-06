/**
 * One agent's conversation: the header band, the messages, and the composer.
 * Scroll sticks to the bottom while you're at the bottom, and stays put when
 * you've scrolled up to read.
 *
 * What you send shows at once, before the backend has it: a pending bubble
 * that the persisted message takes over in place (same React key, so it
 * neither re-animates nor jumps), or that turns into "Not sent" if the send
 * fails.
 *
 * A reply streams in as a draft that grows in place; the finished message
 * carries the draft's id, so it takes over the same bubble without a flicker.
 *
 * @module components/agents/AgentChat
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  HistoryIcon,
  InfoIcon,
  MicrophoneIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { Dropdown } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { CompactModeToggle } from '../workspace/ModeToggle';
import { TextButton } from '../primitives/TextButton';
import { AgentSecretHint } from './AgentSecretHint';
import { AgentModelItems } from './AgentModelMenu';
import { AgentRequestsBar } from './AgentRequests';
import { TextArea } from '../primitives/TextField';
import { AgentAvatar } from './AgentAvatar';
import { AgentActionItems, type AgentActions } from './AgentActions';
import { TakeoverBanner, TakeoverTerminal } from './AgentTakeover';
import { AgentLine, ConversationBar, ConversationBars } from './AgentCard';
import { PhoneSigninBar } from './PhoneSigninBar';
import {
  needsLine,
  templateOf,
  type RoleTemplate,
  type TemplateStarter,
} from '../../lib/agentTemplates';
import { CHIEF_CHIPS, type ChiefIdea } from '../../lib/chiefIdeas';
import { AgentSchedulePopover } from './AgentSchedulePopover';
import { AgentFilesModal } from './AgentFilesModal';
import { RememberModal } from './AgentRemember';
import { useArrivals, useFollowBottom, usePresence } from './useAgentMotion';
import { useRowAnchoring } from './useRowAnchoring';
import { useDictation } from './useDictation';
import { blockedCopy, dictationVocabulary, openPrivacySettings } from '../../lib/dictation';
import { listProjects } from '../../lib/project';
import { ComposerAttachments, ComposerQuotes } from './AgentAttachments';
import {
  toOutgoing,
  useComposerAttachments,
  useFileDrop,
  type DraftAttachment,
} from './useComposerAttachments';
import { AgentSwitcher } from './AgentSwitcher';
import { useQuoteSelection } from './useQuoteSelection';
import { useMentionPicker } from './AgentMentions';
import { useCommands } from '../../commands/useCommands';
import {
  AgentBubble,
  ApprovalCard,
  DayDivider,
  CheckInLine,
  ConnectorBubble,
  ErrorLine,
  FreshHint,
  NoteLine,
  PeerGroup,
  UserBubble,
  WorkingIndicator,
} from './AgentChatItems';
import { DecideCards } from './AgentAdmin';
import { AgentProjectChip, ChangeCard, useAgentProjects } from './AgentProject';
import { ComposerRevising, ResultCardView } from './AgentResult';
import { AgentGalleryProvider } from './AgentGallery';
import { SessionCard } from './AgentSession';
import { RoomFoldLine, RoomWorkingPlace } from './AgentRoomParts';
import { takeHandedRevision } from '../../lib/agentRooms';
import {
  answerApproval,
  buildChatItems,
  createCheckIn,
  drivingBriefId,
  newestPeerGroups,
  interruptAgent,
  isQueued,
  retryExtras,
  retrySourceFor,
  resendable,
  retryNote,
  whenAt,
  mentionedAgents,
  isImportInterviewActivity,
  plainActivity,
  approvalSeries,
  withQuotes,
  newestResults,
  sendAgentMessage,
  sortAgents,
  stopAgent,
  type Agent,
  type AgentTurn,
  type ChatItem,
  type AgentMessage,
  type AgentRef,
  type OutgoingAttachment,
  type ResultRef,
  ENGINE_LABEL,
  engineCantAsk,
  engineIsReady,
  roleWithoutPath,
} from '../../lib/agents';
import {
  agentIn,
  getAgentsSnapshot,
  loadOlderMessages,
  markSent,
  refreshAgents,
  upsertMessage,
  useAgentsList,
  useAgentsSelector,
  type AgentsState,
} from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { ImportTalkBar } from './ImportTalkBar';
import { WaitingForYouBar } from './WaitingForYouBar';
import { TeamSetupCard } from './TeamSetupCard';
import {
  progressLine,
  quietAgentIds,
  SETUP_BAR_TITLE,
  setupAnchorTs,
  setupItemIndex,
  showTeamSetup,
  useTeamSetup,
  useTeamSetupReveal,
} from '../../lib/teamSetup';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useAccentScope } from '../../lib/accent';
import { AccentScopeProvider } from '../../contexts/AccentScopeContext';

/**
 * The Chief's first open: three workflows that run without the user
 * (overnight fixes, a team with a standup, briefs that start projects;
 * `lib/chiefIdeas.ts`), and "More ideas…" for the rest. Each types a whole
 * brief into the composer for the user to finish; nothing is sent until they
 * press Send. What one needs (GitHub, a folder) the Chief sets up first. Importing isn't the Chief's job (the other assistant does it), so
 * that one opens the import steps instead.
 */
function ChiefStarters({
  onIdea,
  onMore,
  onImport,
}: {
  onIdea: (idea: ChiefIdea) => void;
  onMore?: () => void;
  /** With no sidebar to hold the import note, the starters offer it. */
  onImport?: () => void;
}) {
  return (
    <div className="agent-chat__starters">
      {CHIEF_CHIPS.map((idea) => (
        <Button
          key={idea.id}
          tabIndex={0}
          variant="secondary"
          data-idea={idea.id}
          onClick={() => onIdea(idea)}
        >
          {idea.label}
        </Button>
      ))}
      {onMore && (
        <Button tabIndex={0} variant="ghost" data-idea="more" onClick={onMore}>
          More ideas…
        </Button>
      )}
      {onImport && (
        <Button tabIndex={0} variant="secondary" onClick={onImport}>
          Import agents…
        </Button>
      )}
    </div>
  );
}
/** Any other agent's first open: what to ask a new teammate. */
const AGENT_STARTERS = ['What’s on your plate?', 'Check in with me tomorrow at 9'];

/**
 * A ready-made agent's first open: its own starters, and, for one that can't
 * work alone, the one line saying what it needs with the way to connect it.
 */
function TemplateStarters({
  template,
  engine,
  onStarter,
  onOpenApps,
}: {
  template: RoleTemplate;
  engine: Agent['engine'];
  onStarter: (starter: TemplateStarter) => void;
  onOpenApps?: () => void;
}) {
  const needs = needsLine(template, engine);
  return (
    <>
      {needs && (
        <AgentLine className="agent-chat__needs">
          {needs}
          {engine === 'claude' && onOpenApps && (
            <>
              {' '}
              <TextButton tabIndex={0} onClick={onOpenApps}>
                Connect an app…
              </TextButton>
            </>
          )}
        </AgentLine>
      )}
      <div className="agent-chat__starters agent-chat__starters--centred">
        {template.starters.map((starter) => (
          <Button
            key={starter.label}
            tabIndex={0}
            variant="secondary"
            onClick={() => onStarter(starter)}
          >
            {starter.label}
          </Button>
        ))}
      </div>
    </>
  );
}

/** A second Esc within this long stops a working agent; the first only says so. */
const ESC_CONFIRM_MS = 1500;

/** Within this many px of the bottom counts as "at the bottom". */
const STICK_THRESHOLD = 80;

/** Older lines start loading while this many screens of history are still above. */
const LOAD_AHEAD_SCREENS = 1.5;

/**
 * A chat opens with this many of its newest lines in the DOM, and mounts more
 * of what's loaded, this many at a time, as you scroll up: the same steps as
 * a page from the backend (`MESSAGE_PAGE`). Lines stay mounted once shown.
 * Reopening a chat with thousands of lines loaded mounted all of them, a
 * quarter-second task, before you saw any.
 */
const MOUNT_PAGE = 150;

/** The first message an item stands for (a day divider stands for none). */
function itemMessageId(item: ChatItem | undefined): string | null {
  if (!item || item.type === 'day') return null;
  return item.type === 'message' ? item.message.id : item.messages[0].id;
}

/**
 * Where the mounted lines start: at the item holding `from`, with the day
 * divider that opens it. Everything, if `from` is null or gone.
 */
function itemIndexOf(items: ChatItem[], id: string): number {
  return items.findIndex((item) =>
    item.type === 'day'
      ? false
      : item.type === 'message'
        ? item.message.id === id
        : item.messages.some((m) => m.id === id)
  );
}

function mountStart(items: ChatItem[], from: string | null): number {
  if (from === null) return 0;
  let at = itemIndexOf(items, from);
  if (at < 0) return 0;
  while (at > 0 && items[at - 1].type === 'day') at--;
  return at;
}

/** The first message id of the newest `count` items: where a chat opens. */
function newestFrom(items: ChatItem[], count: number): string | null {
  for (let i = Math.max(0, items.length - count); i > 0 && i < items.length; i++) {
    const id = itemMessageId(items[i]);
    if (id) return id;
  }
  return null;
}

/**
 * A function whose identity never changes but always runs the latest render's
 * version, so the memoised rows below can take it without re-rendering.
 */
function useStableEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** Something you sent from this chat; `id` once the backend has it. */
interface Pending {
  key: string;
  text: string;
  ts: number;
  failed: boolean;
  id?: string;
  mentions: AgentRef[];
  /** Files still being copied in, shown as staged until the message lands. */
  files?: DraftAttachment[];
  /** A retry's files, already in the agent's home: sent again by path. */
  resend?: OutgoingAttachment[];
  /** "Ask for changes": the result this message asks to revise. */
  revises?: ResultRef;
}

function newPending(text: string, mentions: AgentRef[], extra: Partial<Pending> = {}): Pending {
  return {
    key: `local-${crypto.randomUUID()}`,
    text,
    ts: Date.now(),
    failed: false,
    mentions,
    ...extra,
  };
}

interface AgentChatProps extends AgentActions {
  agent: Agent;
  onOpenAgent: (agentId: string) => void;
  onSetUpEngine: () => void;
  /** The expired-login remedy on an error line. */
  onSignIn: () => void;
  onImport: () => void;
  /** Esc in the composer: true if something above it (search) took it. */
  onEscape?: () => boolean;
  /** Below the compact breakpoint the sidebar is gone; the header carries navigation. */
  compact?: { onGoHome: () => void; onGoProjects: () => void };
  /** A search result to scroll to and flash; `onJumped` is called once it's shown. */
  jumpTo?: string | null;
  onJumped?: () => void;
  /** Words put in the composer for you to finish ("Set up an agent that "); `n` asks again. */
  prefill?: { text: string; n: number } | null;
  /** "Apps your agents can use", for a ready-made agent that needs one. */
  onOpenApps?: () => void;
  /** The Chief's "More ideas…": the gallery of things to ask it. */
  onMoreIdeas?: () => void;
}

/** Unsent composer text per agent, for the life of the window. */
const unsentText = new Map<string, string>();

/**
 * The reply being written, as far as the history needs to know: which one and
 * when it started. Its words are read by its own bubble (`DraftProse`), so a
 * delta re-renders that bubble and nothing else.
 */
function draftHeadOf(s: AgentsState, agentId: string): AgentMessage | null {
  const draft = s.drafts[agentId];
  // Whitespace that hasn't become words yet isn't worth a bubble.
  return draft && draft.text.trim() ? draft : null;
}
const sameDraftHead = (a: AgentMessage | null, b: AgentMessage | null) =>
  a === b || (a !== null && b !== null && a.id === b.id && a.ts === b.ts);

/**
 * Who the @mention picker offers and what it shows of them, in any order: the
 * sidebar order changes with every message anywhere, and the chat isn't
 * re-rendered for that. The order is read when the picker is (`draft`).
 */
const mentionKey = (a: Agent) => `${a.id}\u0000${a.name}\u0000${a.color}\u0000${a.role}`;
const sameMentionable = (a: Agent[], b: Agent[]) => {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(mentionKey));
  return b.every((x) => keys.has(mentionKey(x)));
};

/** The agent switcher reads the list itself: the chat around it doesn't need it. */
function LiveAgentSwitcher(props: Omit<ComponentProps<typeof AgentSwitcher>, 'agents'>) {
  const agents = useAgentsList();
  return <AgentSwitcher agents={agents} {...props} />;
}

/**
 * Memoised, and fed only this agent and stable callbacks: a status event for
 * any other agent leaves the conversation on screen alone.
 */
export const AgentChat = memo(function AgentChat({
  agent,
  onOpenAgent,
  onSetUpEngine,
  onSignIn,
  onImport,
  onEscape,
  compact,
  jumpTo,
  onJumped,
  prefill,
  onOpenApps,
  onMoreIdeas,
  ...actions
}: AgentChatProps) {
  // Everything in this conversation takes on the agent's colour.
  const accentScope = useAccentScope(agent.color);
  // This chat's slices only: another agent's reply streaming doesn't touch it.
  const messages = useAgentsSelector((s) => s.messages[agent.id]);
  const draftHead = useAgentsSelector((s) => draftHeadOf(s, agent.id), sameDraftHead);
  const engineReady = useAgentsSelector((s) =>
    engineIsReady(agent.engine, s.engines, s.engineReady)
  );
  /** Installed but signed out: the blocked composer offers sign-in, not an install. */
  const engineInstalled = useAgentsSelector(
    (s) => s.engines.find((e) => e.id === agent.engine)?.installed ?? false
  );
  // An engine whose turns can't stop to ask refuses instead: said where you talk to it.
  const cantAsk = useAgentsSelector((s) => engineCantAsk(agent.engine, s.engines));
  const hasOlder = useAgentsSelector((s) => s.older[agent.id] ?? false);
  // A reply streaming in a room is the room's: shown there, not here as if
  // it were for you (the working line says where it is answering).
  const inRoom = agent.status.state !== 'idle' ? agent.status.room : undefined;
  // The streaming bubble's place in the history: the same object for the
  // whole reply, so the history is built once when it starts, not per word.
  const streaming = useMemo(
    () => (!inRoom && draftHead ? { ...draftHead, text: '' } : null),
    [draftHead, inRoom]
  );
  const { showToast } = useOptionalToast();
  // Kept outside the component: an agent opening a project switches this
  // window away from Agents and back, and what you were typing survives it.
  const [draft, setDraft] = useState(() => unsentText.get(agent.id) ?? '');
  useEffect(() => {
    if (draft) unsentText.set(agent.id, draft);
    else unsentText.delete(agent.id);
  }, [agent.id, draft]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  // A request drafted elsewhere (New agent's "Ask your Chief of Staff"): in
  // the composer, caret at its end, for you to finish and send.
  useEffect(() => {
    if (!prefill) return;
    setDraft(prefill.text);
    const frame = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(prefill.text.length, prefill.text.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [prefill?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const micRef = useRef<HTMLButtonElement>(null);
  const getDraft = useCallback(() => draftRef.current, []);
  const getVocabulary = useCallback(
    async () =>
      dictationVocabulary(
        getAgentsSnapshot().agents.map((a) => a.name),
        (await listProjects().catch(() => [])).map((p) => p.name)
      ),
    []
  );
  const dictation = useDictation({
    getDraft,
    setDraft,
    getVocabulary,
    meterRef: micRef,
    enabled: engineReady,
  });
  const dictating = dictation.phase !== 'idle';
  const blocked = dictation.blocked ? blockedCopy(dictation.blocked) : null;
  const sectionRef = useRef<HTMLElement>(null);

  const [scheduleOpen, setScheduleOpen] = useState(false);
  // Opened from ⌘K's "Start work when something happens…": on the When… composer.
  const [scheduleWhen, setScheduleWhen] = useState(false);
  const openSchedule = useCallback((open: boolean) => {
    setScheduleOpen(open);
    if (!open) setScheduleWhen(false);
  }, []);
  const [filesOpen, setFilesOpen] = useState(false);
  // While you drive an agent with no project to open, its session is shown
  // here in place of the conversation, until you ask for the chat.
  const takeover = agent.takeover;
  const driven = Boolean(takeover);
  const [chatFor, setChatFor] = useState<string | null>(null);
  const terminalShown = Boolean(takeover && !takeover.project && chatFor !== takeover.ptySession);
  const toggleTerminal = useCallback(() => {
    const pty = agent.takeover?.ptySession ?? null;
    setChatFor((shown) => (shown === pty ? null : pty));
  }, [agent.takeover?.ptySession]);
  const [remembering, setRemembering] = useState<AgentMessage | null>(null);

  // Who you can @mention here: everyone else on the team, in sidebar order.
  const mentionSet = useAgentsSelector(
    (s) => s.agents.filter((a) => !a.hidden && a.id !== agent.id),
    sameMentionable
  );
  // In sidebar order as it is now: computed again as you type, so the picker
  // opening on "@" lists them the way the sidebar does at that moment.
  const mentionable = useMemo(() => {
    const order = new Map(sortAgents(getAgentsSnapshot().agents).map((a, i) => [a.id, i]));
    return [...mentionSet].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }, [mentionSet, draft]); // eslint-disable-line react-hooks/exhaustive-deps -- `draft`: re-read the order as you type
  const mentionPicker = useMentionPicker(mentionable, inputRef, setDraft);
  const mentionsIn = (text: string): AgentRef[] =>
    mentionedAgents(text, mentionable).map(({ id, name }) => ({ id, name }));

  useCommands(
    () => [
      {
        id: 'agents.scheduleCheckIn',
        title: `Schedule a routine for ${agent.name}…`,
        icon: <HistoryIcon size={14} />,
        category: 'action',
        keywords: ['routine', 'remind', 'every', 'recurring', 'later', 'scheduled'],
        when: () => engineReady,
        run: () => setScheduleOpen(true),
      },
      {
        id: 'agents.whenRoutine',
        title: `Start work for ${agent.name} when something happens…`,
        icon: <HistoryIcon size={14} />,
        category: 'action',
        keywords: [
          'when',
          'trigger',
          'event',
          'github',
          'mention',
          'linear',
          'folder',
          'watch',
          'routine',
        ],
        when: () => engineReady,
        run: () => {
          setScheduleWhen(true);
          setScheduleOpen(true);
        },
      },
      {
        id: 'agents.files',
        title: `Files shared with ${agent.name}`,
        icon: <PaperclipIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'attachments', 'shared', 'downloads', 'report', 'documents'],
        run: () => setFilesOpen(true),
      },
    ],
    [agent.name, engineReady]
  );

  const toastError = useCallback((message: string) => showToast(message, 'error'), [showToast]);
  const attachments = useComposerAttachments(toastError);
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

  // Quotes wait above the text as chips; each ⌘L adds one. They're sent as
  // Markdown blockquotes ahead of what was typed.
  const [quotes, setQuotes] = useState<string[]>([]);
  const insertQuote = useCallback((text: string) => {
    setQuotes((current) => [...current, text]);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  const removeQuote = useCallback(
    (index: number) => setQuotes((current) => current.filter((_, i) => i !== index)),
    []
  );
  const quoting = useQuoteSelection(scrollRef, sectionRef, insertQuote);
  // "Ask for changes" on a result card: the next message revises it. It
  // waits above the text like a quote, and goes with the send.
  // "Ask for changes" in a room opens this chat with the request staged.
  const [revising, setRevising] = useState<ResultRef | null>(() => takeHandedRevision(agent.id));

  useCommands(
    () => [
      {
        id: 'agents.attachFiles',
        title: `Attach files for ${agent.name}…`,
        icon: <PaperclipIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'upload', 'image', 'screenshot', 'file', 'paperclip'],
        when: () => engineReady,
        run: pickFiles,
      },
    ],
    [agent.name, engineReady, pickFiles]
  );

  // Focus the composer on open (mounted once per agent, keyed by id, so the
  // draft starts empty) and again when dictation ends, wherever it started.
  useEffect(() => {
    if (!dictating) inputRef.current?.focus();
  }, [dictating]);

  // A pending bubble gives way as soon as its message is in the store, which
  // can be before the send call returns (the backend's event can win). The
  // persisted message then renders under the pending bubble's key.
  const { shown, aliases, failed, sending } = useMemo(() => {
    const list = messages ?? [];
    const aliases = new Map<string, string>();
    const local: AgentMessage[] = [];
    const failed = new Set<string>();
    const sending = new Map<string, DraftAttachment[]>();
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
        agentId: agent.id,
        ts: p.ts,
        kind: 'user',
        text: p.text,
        mentions: p.mentions,
        ...(p.revises ? { revises: p.revises } : {}),
      });
      if (p.failed) failed.add(p.key);
      else if (p.files) sending.set(p.key, p.files);
    }
    // The reply being written sits after what's settled and before anything
    // you've just sent, which it will read next.
    const draft = streaming && !list.some((m) => m.id === streaming.id) ? [streaming] : [];
    return { shown: [...list, ...draft, ...local], aliases, failed, sending };
  }, [messages, pending, agent.id, streaming]);

  // What the rows read from the agent. A status or activity change re-renders
  // the header and the indicator, never the history.
  const rowAgent = useMemo(() => agent, [agent.id, agent.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const projectsCtx = useAgentProjects();
  // Whose home a picture in the gallery lives in: this agent, or one whose
  // line shows here (a peer's), read when the picture opens.
  const galleryAgentOf = useCallback(
    (id: string) => (id === rowAgent.id ? rowAgent : agentIn(getAgentsSnapshot().agents, id)),
    [rowAgent]
  );
  // Tints for @mentions, keyed by the colours themselves: a status event
  // elsewhere gives a new agents list but the same colours.
  const colorKey = useAgentsSelector((s) => s.agents.map((a) => `${a.id}:${a.color}`).join(' '));
  // Who exists, and who is visible, as strings: the same for every status event.
  const allIds = useAgentsSelector((s) => s.agents.map((a) => a.id).join(' '));
  const visibleIds = useAgentsSelector((s) =>
    s.agents
      .filter((a) => !a.hidden)
      .map((a) => a.id)
      .join(' ')
  );
  const existing = useMemo(() => new Set(allIds.split(' ')), [allIds]);
  const visible = useMemo(() => new Set(visibleIds.split(' ')), [visibleIds]);
  const colorOf = useMemo(() => {
    const colors = new Map(colorKey.split(' ').map((pair) => pair.split(':') as [string, string]));
    return (id: string) => colors.get(id);
  }, [colorKey]);

  // Another agent's request (a question its project session is waiting on)
  // is offered here one way only: the "Review <name>'s request" chip at the
  // foot, which opens the same card in place. Not also as a full card inline.
  // Keyed by the owners themselves: the same owners must not rebuild the history.
  const foreignKey = useMemo(() => {
    const owners = new Set<string>();
    for (const m of shown) {
      const owner = m.approval?.prompt?.owner.id;
      if (!owner || owner === agent.id) continue;
      if (visible.has(owner)) owners.add(owner);
    }
    return [...owners].sort().join(' ');
  }, [shown, agent.id, visible]);
  const foreignOwners = useMemo(
    () => new Set(foreignKey ? foreignKey.split(' ') : []),
    [foreignKey]
  );
  const listed = useMemo(
    () =>
      foreignOwners.size === 0
        ? shown
        : shown.filter((m) => !foreignOwners.has(m.approval?.prompt?.owner.id ?? '')),
    [shown, foreignOwners]
  );
  // The agent's open copy of its project: only its newest card offers Keep /
  // Discard, and that card reads the live status (it waits while working).
  const copyId = agent.copy?.id;
  const liveCopyCard = useMemo(() => {
    if (!copyId) return null;
    for (let i = shown.length - 1; i >= 0; i--) {
      const m = shown[i];
      if (m.kind === 'changes' && m.changes?.copy?.id === copyId) return m.id;
    }
    return null;
  }, [shown, copyId]);
  // Said in a room, a line folds to "Replied in <room>", except the card for
  // its open copy (Keep / Discard stays here too) and lines from a room that
  // is gone, which have nowhere else to be read.
  const roomsLoaded = useAgentsSelector((s) => s.roomsLoaded);
  const roomIds = useAgentsSelector((s) => s.rooms.map((r) => r.id).join(' '));
  const items = useMemo(() => {
    const rooms = new Set(roomIds ? roomIds.split(' ') : []);
    return buildChatItems(listed, {
      unfolded: liveCopyCard,
      folds: (roomId) => !roomsLoaded || rooms.has(roomId),
    });
  }, [listed, liveCopyCard, roomsLoaded, roomIds]);
  // The lines in the DOM: from `mountFrom` on (all of them when null).
  const [mountFrom, setMountFrom] = useState<string | null>(() => newestFrom(items, MOUNT_PAGE));
  const startIndex = useMemo(() => mountStart(items, mountFrom), [items, mountFrom]);
  const copyAgent = liveCopyCard ? agent : undefined;
  // Each result's newest version is drawn in full; older ones fold.
  const newestResult = useMemo(() => new Set(newestResults(shown).values()), [shown]);
  /** Nothing yet but what the Chief said first: the user hasn't spoken. */
  const greetingOnly =
    agent.isMain &&
    shown.length > 0 &&
    shown.every((m) => m.kind === 'agent') &&
    agent.status.state === 'idle';
  const templateFirstOpen =
    !agent.isMain &&
    agent.template !== undefined &&
    shown.length > 0 &&
    shown.every((m) => m.kind === 'note') &&
    agent.status.state === 'idle';
  const livePeerLines = useMemo(() => newestPeerGroups(items), [items]);
  const similar = useMemo(() => approvalSeries(items), [items]);
  // Who this chat has worked with, and the cards already in it: for the
  // other agents' requests offered at its foot.
  const peerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of items) {
      if (item.type === 'peer-group') ids.add(item.peer.id);
      else if (item.type === 'message' && item.message.peer) ids.add(item.message.peer.id);
    }
    return ids;
  }, [items]);
  // "Setting up your team", in the Chief's chat after an import. Its logins
  // are answered on it, so they aren't offered again as "Review X's request".
  const teamSetup = useTeamSetup();
  const setupHere = agent.isMain ? teamSetup : null;
  const shownRequestIds = useMemo(() => {
    const ids = new Set(listed.flatMap((m) => (m.approval ? [m.approval.requestId] : [])));
    // Cards an admin brought here are already answerable in the chat.
    for (const m of listed) for (const d of m.decide ?? []) ids.add(d.approval.requestId);
    if (setupHere && !setupHere.complete) {
      for (const step of setupHere.steps) {
        for (const l of step.logins ?? []) ids.add(l.requestId);
      }
    }
    return ids;
  }, [listed, setupHere]);
  // The card sits where it was posted, like a message: everything said
  // after it comes below it (-1: above the lines loaded so far).
  const setupAt = useMemo(
    () => (setupHere ? setupItemIndex(items, setupAnchorTs(setupHere, listed), hasOlder) : -1),
    [setupHere, items, listed, hasOlder]
  );
  // The agents still being set up: their requests open the checklist, not
  // the requests panel.
  const setupBarTarget = useMemo(
    () =>
      setupHere && !setupHere.complete
        ? { agentIds: quietAgentIds(setupHere), onOpen: showTeamSetup }
        : undefined,
    [setupHere]
  );
  // These read only the turn's state and start, and a take-over's: not the
  // activity line that changes with every step.
  const turnState = agent.status.state;
  const turnSince = agent.status.since;
  const takeoverSince = agent.takeover?.since;
  const turn = useMemo(
    () =>
      ({
        status: { state: turnState, since: turnSince },
        takeover: takeoverSince === undefined ? undefined : { since: takeoverSince },
      }) satisfies AgentTurn,
    [turnState, turnSince, takeoverSince]
  );
  const drivingId = useMemo(() => drivingBriefId(items, turn), [items, turn]);
  // Retry belongs to the newest failure only, and only if nothing was said
  // since. It sends that message again whole: its words and its files.
  const retrySource = useMemo(() => retrySourceFor(shown), [shown]);
  const retryId = retrySource ? shown[shown.length - 1].id : null;
  // Mid-turn, what you send waits for the next turn. The newest waiting
  // message says so and offers to interrupt instead.
  const busy = agent.status.state !== 'idle';
  const queuedId = useMemo(() => {
    const waiting = shown.filter((m) => !failed.has(m.id) && isQueued(m, turn));
    return waiting[waiting.length - 1]?.id ?? null;
  }, [shown, failed, turn]);
  // A card left open after the turn ended is not "working": no dots, no Stop.
  const working = agent.status.state === 'working';
  // While words are arriving they are the sign of life; the dots and what
  // it's doing come back between text blocks, while tools run.
  const indicator = usePresence(working && !streaming);
  const jump = usePresence(!atBottom);
  // What it's doing now goes above what's waiting: the indicator sits before
  // the run of queued messages at the end, not under them.
  const queuedFrom = useMemo(() => {
    let from = items.length;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'day') continue;
      if (item.type !== 'message' || !isQueued(item.message, turn)) break;
      from = i;
    }
    // Leave a day divider that opens the run above the indicator, with its day.
    while (from < items.length && items[from].type === 'day') from++;
    return from;
  }, [items, turn]);

  // Only lines that arrive while the chat is open animate in.
  const messageIds = useMemo(() => messages?.map((m) => m.id), [messages]);
  const isArrived = useArrivals(messageIds);
  const arrivedAt = useCallback(
    function arrivedAt(index: number): boolean {
      const item = items[index];
      if (!item) return false;
      if (item.type === 'day') return arrivedAt(index + 1);
      return isArrived(item.type === 'message' ? item.message.id : item.messages[0].id);
    },
    [items, isArrived]
  );
  const newestArrived = arrivedAt(items.length - 1);

  const messagesRef = useRef<HTMLDivElement>(null);
  const { follow, isGliding, readerScrolled } = useFollowBottom(
    scrollRef,
    messagesRef,
    atBottomRef
  );
  useRowAnchoring(scrollRef, messagesRef);

  // Follow new content only if the reader was already at the bottom: glide
  // to a new line, land on the bottom (before paint) on first render. A reply
  // growing is not a new line: it stays pinned without a glide per word.
  const lastItem = items[items.length - 1];
  const lastKey = !lastItem
    ? ''
    : lastItem.type === 'day'
      ? `day-${lastItem.ts}`
      : lastItem.type === 'message'
        ? lastItem.message.id
        : lastItem.messages[0].id;
  const lastKeyRef = useRef(lastKey);
  // Only a new last line asks: anything that merely grows or shrinks (the
  // working line, a reply streaming, a card answered) is the ResizeObserver's
  // in `useFollowBottom`. Asking on every status change read the whole
  // history's layout inside the commit, which was most of a busy chat's cost.
  const newestArrivedRef = useRef(newestArrived);
  newestArrivedRef.current = newestArrived;
  useLayoutEffect(() => {
    const isNew = lastKeyRef.current !== lastKey;
    lastKeyRef.current = lastKey;
    if (atBottomRef.current) follow(newestArrivedRef.current && isNew);
  }, [lastKey, follow]);

  // Older lines load above as you near the top. The line that was first stays
  // exactly where it was on screen: its offset in the content is taken before
  // the load and the scroll moved by however far it was pushed down.
  const anchorRef = useRef<{ firstId: string; el: HTMLElement; offset: number } | null>(null);
  const loadEarlier = useCallback(() => {
    const first = messagesRef.current?.querySelector<HTMLElement>('[data-message-ids]');
    const firstId = messages?.[0]?.id;
    if (!first || !firstId) return;
    // Everything loaded is mounted by now, and so will what arrives be.
    setMountFrom(null);
    anchorRef.current = { firstId, el: first, offset: first.offsetTop };
    // WebKit has no scroll anchoring; Chromium's would add its own correction
    // to ours, so it's off until the page is in.
    const el = scrollRef.current;
    if (el) el.style.overflowAnchor = 'none';
    void loadOlderMessages(agent.id).then(() =>
      // Nothing came (a failed read): stand down.
      requestAnimationFrame(() => {
        if (anchorRef.current?.firstId !== firstId) return;
        anchorRef.current = null;
        if (el) el.style.overflowAnchor = '';
      })
    );
  }, [agent.id, messages]);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const el = scrollRef.current;
    // Only once the older lines are in: a reply landing meanwhile isn't it.
    if (!anchor || !el || messages?.[0]?.id === anchor.firstId) return;
    anchorRef.current = null;
    if (anchor.el.isConnected) el.scrollTop += anchor.el.offsetTop - anchor.offset;
    el.style.overflowAnchor = '';
  }, [messages]);

  // Lines already loaded but not yet mounted come in above the same way,
  // before anything is asked of the backend.
  const revealRef = useRef<{ el: HTMLElement; offset: number } | null>(null);
  const revealEarlier = useCallback(() => {
    if (revealRef.current) return;
    const first = messagesRef.current?.querySelector<HTMLElement>('[data-message-ids]');
    const el = scrollRef.current;
    if (!first || !el) return;
    revealRef.current = { el: first, offset: first.offsetTop };
    el.style.overflowAnchor = 'none';
    setMountFrom(newestFrom(items, items.length - startIndex + MOUNT_PAGE));
  }, [items, startIndex]);
  useLayoutEffect(() => {
    const anchor = revealRef.current;
    const el = scrollRef.current;
    if (!anchor || !el) return;
    revealRef.current = null;
    if (anchor.el.isConnected) el.scrollTop += anchor.el.offsetTop - anchor.offset;
    el.style.overflowAnchor = '';
  }, [startIndex]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || isGliding()) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    // Following, and the reader didn't move it: the page moved under it
    // (lines above drawn at their real height). Stay with the newest line.
    if (!bottom && atBottomRef.current && !readerScrolled()) {
      follow(false);
      return;
    }
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (el.scrollTop >= el.clientHeight * LOAD_AHEAD_SCREENS) return;
    if (startIndex > 0) revealEarlier();
    else if (hasOlder) loadEarlier();
  }, [isGliding, readerScrolled, follow, hasOlder, loadEarlier, startIndex, revealEarlier]);

  // A search hit: bring its line to the middle and flash it. A line older
  // than what's loaded loads back to it first (once); one that's gone just stops.
  const jumpLoad = useRef<{ id: string; done: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!jumpTo || !messages) return;
    const target = messagesRef.current?.querySelector<HTMLElement>(
      `[data-message-ids~="${CSS.escape(jumpTo)}"]`
    );
    if (!target) {
      // Loaded, but above the lines mounted so far: mount from it.
      const at = itemIndexOf(items, jumpTo);
      if (at >= 0 && at < startIndex) {
        setMountFrom(jumpTo);
        return;
      }
      const load = jumpLoad.current;
      if (load?.id !== jumpTo && hasOlder) {
        const entry = { id: jumpTo, done: false };
        jumpLoad.current = entry;
        void loadOlderMessages(agent.id, jumpTo).then(() => {
          entry.done = true;
        });
      } else if (load?.id !== jumpTo || load.done) {
        onJumped?.();
      }
      return;
    }
    // The scroll handler settles `atBottom`; until then, don't follow new lines.
    atBottomRef.current = false;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Restart the flash if it's already running (the same hit, clicked twice).
    target.removeAttribute('data-flash');
    void target.offsetWidth;
    target.setAttribute('data-flash', '');
    const clear = (e: AnimationEvent) => {
      if (e.animationName !== 'agents-motion-flash') return;
      target.removeAttribute('data-flash');
      target.removeEventListener('animationend', clear);
    };
    target.addEventListener('animationend', clear);
    // Typing goes on in this conversation, not into whatever was clicked.
    inputRef.current?.focus({ preventScroll: true });
    onJumped?.();
  }, [jumpTo, messages, hasOlder, agent.id, onJumped, items, startIndex]);

  // Continue (the bar, ⌘K, What's in flight): go to the card where it was
  // posted, mounting or loading back to it first, and flash it.
  const setupReveal = useTeamSetupReveal(agent.isMain);
  const setupRevealed = useRef(0);
  useLayoutEffect(() => {
    const ask = setupReveal.ask;
    if (!ask || setupRevealed.current === ask || !setupHere) return;
    const row = messagesRef.current?.querySelector<HTMLElement>('[data-team-setup]');
    if (!row) {
      if (setupAt >= 0 && setupAt < startIndex) {
        const id = items.slice(setupAt).map(itemMessageId).find(Boolean);
        if (id) {
          setMountFrom(id);
          return;
        }
      }
      if (setupAt < 0 && hasOlder) {
        void loadOlderMessages(agent.id);
        return;
      }
      setupRevealed.current = ask;
      setupReveal.done();
      return;
    }
    setupRevealed.current = ask;
    setupReveal.done();
    atBottomRef.current = false;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.removeAttribute('data-flash');
    void row.offsetWidth;
    row.setAttribute('data-flash', '');
    const clear = (e: AnimationEvent) => {
      if (e.animationName !== 'agents-motion-flash') return;
      row.removeAttribute('data-flash');
      row.removeEventListener('animationend', clear);
    };
    row.addEventListener('animationend', clear);
  }, [setupReveal, setupHere, setupAt, startIndex, items, hasOlder, agent.id]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const staged = attachments.items;
  const canSend = draft.trim().length > 0 || staged.length > 0 || quotes.length > 0;

  const interrupt = async () => {
    try {
      await interruptAgent(agent.id);
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  /** `now`: interrupt the turn in progress once it has the message (⌘↵). */
  const deliver = async (entry: Pending, now = false) => {
    try {
      const ids = entry.mentions.map((m) => m.id);
      const message = await sendAgentMessage(
        agent.id,
        entry.text,
        entry.resend,
        ids,
        entry.revises?.id
      );
      setPending((list) => list.map((p) => (p.key === entry.key ? { ...p, id: message.id } : p)));
      upsertMessage(message);
      if (now) await interrupt();
    } catch (error) {
      setPending((list) => list.map((p) => (p.key === entry.key ? { ...p, failed: true } : p)));
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  // Words alone appear at once and retry in place. Files have to be copied
  // into the agent's home first, so that send shows them as they were staged,
  // marked "Sending…", and a failure puts everything back in the composer.
  const sendWithFiles = async (
    typed: string,
    quoted: string[],
    files: typeof staged,
    now: boolean
  ) => {
    atBottomRef.current = true;
    const text = withQuotes(quoted, typed);
    const asked = revising;
    const entry = newPending(text, mentionsIn(typed), {
      files,
      ...(asked ? { revises: asked } : {}),
    });
    setPending((list) => [...list, entry]);
    try {
      const outgoing = await toOutgoing(files);
      const ids = entry.mentions.map((m) => m.id);
      const message = await sendAgentMessage(agent.id, text, outgoing, ids, asked?.id);
      setPending((list) =>
        list.map((p) => (p.key === entry.key ? { ...p, id: message.id, files: undefined } : p))
      );
      upsertMessage(message);
      if (now) await interrupt();
    } catch (error) {
      setPending((list) => list.filter((p) => p.key !== entry.key));
      setDraft(typed);
      setQuotes(quoted);
      setRevising(asked);
      attachments.setItems(files);
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  /** Words alone (or a retry's files, already here): on screen at once, and in the row. */
  const sendText = (text: string, now = false, extra: Partial<Pending> = {}) => {
    atBottomRef.current = true;
    const entry = newPending(text, extra.mentions ?? mentionsIn(text), extra);
    setPending((list) => [...list, entry]);
    markSent(agent.id, text);
    void deliver(entry, now);
  };

  /** A starter: sent, and the composer ready for the answer to whatever it asks back. */
  const sendStarter = (text: string) => {
    sendText(text);
    inputRef.current?.focus();
  };

  /** Words in the composer, caret at the end, for the user to finish and send. */
  const typeStarter = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(text.length, text.length);
    });
  };

  /** An idea for the Chief: its brief typed out for the user to finish, nothing sent. */
  const startIdea = (idea: ChiefIdea) => typeStarter(idea.text);
  const chiefStarters = (
    <ChiefStarters
      onIdea={startIdea}
      onMore={onMoreIdeas}
      onImport={compact ? onImport : undefined}
    />
  );
  const template = agent.isMain ? null : templateOf(agent);
  const templateStarters = template && (
    <TemplateStarters
      template={template}
      engine={agent.engine}
      onStarter={(s) => (s.send ? sendStarter(s.text) : typeStarter(s.text))}
      onOpenApps={onOpenApps}
    />
  );

  const retryFailed = () => {
    if (!retrySource) return;
    sendText(retrySource.text, false, retryExtras(agent, retrySource));
  };

  /** "Retry at 3:00 PM": a one-time check-in at the reset, carrying what was asked and its files. */
  const retryAt = async (at: number) => {
    // A check-in carries words only: its files are named by where they are.
    const files = retrySource ? resendable(agent, retrySource).flatMap((f) => f.path ?? []) : [];
    try {
      await createCheckIn(agent.id, whenAt(at), retryNote(retrySource?.text ?? '', files));
      await refreshAgents();
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  // Esc stops a working agent only when pressed twice: the first says so,
  // quietly, where the hint goes. A reflex dismissal never drops a turn.
  const [escArmed, setEscArmed] = useState(false);
  useEffect(() => {
    if (!escArmed) return;
    const timer = window.setTimeout(() => setEscArmed(false), ESC_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [escArmed]);

  /** `now`: rather than queue behind the turn in progress, interrupt it. */
  const send = (now = false) => {
    if (!canSend || dictating) return;
    const typed = draft.trim();
    setDraft('');
    setQuotes([]);
    setRevising(null);
    if (staged.length > 0) {
      atBottomRef.current = true;
      attachments.setItems([]);
      void sendWithFiles(typed, quotes, staged, now && busy);
      return;
    }
    sendText(withQuotes(quotes, typed), now && busy, revising ? { revises: revising } : {});
  };

  // Stable, for the memoised rows.
  const retry = useStableEvent((key: string) => {
    const entry = pending.find((p) => p.key === key);
    if (!entry) return;
    setPending((list) => list.map((p) => (p.key === key ? { ...p, failed: false } : p)));
    void deliver(entry);
  });
  const interruptNow = useStableEvent(() => void interrupt());
  const askForChanges = useStableEvent((ref: ResultRef) => {
    setRevising(ref);
    inputRef.current?.focus();
  });
  const retryLast = useStableEvent(retryFailed);
  const retryLater = useStableEvent(retryAt);
  const onAnswer = useStableEvent(
    async (requestId: string, allow: boolean, always?: boolean, note?: string, choice?: number) => {
      try {
        await answerApproval(agent.id, requestId, allow, always, note, choice);
      } catch (error) {
        showToast(formatCommandError(asCommandError(error)), 'error');
      }
    }
  );

  const onStop = async () => {
    try {
      await stopAgent(agent.id);
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  // Grow with the text, up to a cap, like a messaging app.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Measure at `auto` with transitions off, put the old height back, then
    // set the new one, so the CSS height transition has a start to run from.
    const previous = el.style.height;
    el.style.transition = 'none';
    el.style.height = 'auto';
    // The cap is CSS's (about eight lines); past it the field scrolls.
    const cap = parseFloat(getComputedStyle(el).maxHeight) || 180;
    const next = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.height = previous || next;
    void el.offsetHeight;
    el.style.transition = '';
    el.style.height = next;
  }, [draft]);

  // Identity only: who this is and what it's for. What it's doing is said
  // once in the sidebar row and once in the conversation (a bar, the working
  // line), never a third time up here.
  const role = agent.role ? roleWithoutPath(agent.role) : '';
  const title = (
    <>
      <AgentAvatar name={agent.name} color={agent.color} selected />
      <h2 className="agent-chat__name">{agent.name}</h2>
      {role && (
        <span className="agent-chat__status" title={role}>
          {role}
        </span>
      )}
    </>
  );

  // The history, memoised: typing, or a status line changing, re-renders none
  // of it, and a growing reply re-renders only its own bubble.
  const rowsPaused = agent.status.state === 'idle';
  const checkIns = agent.checkIns;
  // Mid-import the bar above the composer says what's happening: the
  // working line keeps its dots and doesn't repeat it.
  const activity =
    agent.isMain && isImportInterviewActivity(agent.status.activity)
      ? null
      : plainActivity(agent.status.activity);
  const work = agent.status.work;
  const history = useMemo(
    () =>
      items.slice(startIndex).map((item, at) => {
        const index = startIndex + at;
        if (item.type === 'day')
          return <DayDivider key={`day-${item.ts}`} ts={item.ts} arrived={arrivedAt(index)} />;
        const arrived = arrivedAt(index);
        if (item.type === 'room') {
          return (
            <RoomFoldLine
              key={item.messages[0].id}
              roomId={item.roomId}
              messages={item.messages}
              arrived={arrived}
              onOpenRoom={onOpenAgent}
            />
          );
        }
        if (item.type === 'peer-group') {
          return (
            <PeerGroup
              key={item.messages[0].id}
              peer={item.peer}
              messages={item.messages}
              onOpenPeer={onOpenAgent}
              arrived={arrived}
              reveal={Boolean(jumpTo && item.messages.some((p) => p.id === jumpTo))}
              live={livePeerLines.has(item.messages[0].id)}
              driving={item.messages[0].id === drivingId}
            />
          );
        }
        const m = item.message;
        switch (m.kind) {
          case 'user':
            return (
              <UserBubble
                key={aliases.get(m.id) ?? m.id}
                message={m}
                agent={rowAgent}
                arrived={arrived}
                failed={failed.has(m.id)}
                sending={sending.get(m.id)}
                onRetry={retry}
                queued={m.id === queuedId}
                onInterrupt={interruptNow}
                driven={driven}
                colorOf={colorOf}
                onRemember={setRemembering}
              />
            );
          case 'agent':
            if (m.result) {
              return (
                <ResultCardView
                  key={m.id}
                  message={m}
                  card={m.result}
                  agent={rowAgent}
                  newest={newestResult.has(m.id)}
                  onAskForChanges={askForChanges}
                  onPreview={projectsCtx?.openProject}
                  arrived={arrived}
                  work={m.work}
                />
              );
            }
            if (m.decide?.length) {
              return (
                <div key={m.id} className="agent-decide-message">
                  <AgentBubble
                    message={m}
                    arrived={arrived}
                    agent={rowAgent}
                    streaming={m === streaming}
                    onRemember={setRemembering}
                  />
                  <DecideCards message={m} />
                </div>
              );
            }
            return (
              <AgentBubble
                key={m.id}
                message={m}
                arrived={arrived}
                agent={rowAgent}
                streaming={m === streaming}
                onRemember={setRemembering}
              />
            );
          case 'approval':
            return (
              <ApprovalCard
                key={m.id}
                message={m}
                agentName={rowAgent.name}
                // Only a card still waiting says it paused the turn.
                paused={rowsPaused && m.approval?.status === 'pending'}
                onAnswer={onAnswer}
                arrived={arrived}
                series={similar.get(m.id)}
              />
            );
          case 'error':
            return (
              <ErrorLine
                key={m.id}
                message={m}
                arrived={arrived}
                agent={rowAgent}
                engine={agent.engine}
                onSignIn={onSignIn}
                onRetry={m.id === retryId ? retryLast : undefined}
                onRetryAt={retryLater}
                retryScheduled={Boolean(
                  m.failure?.resetsAt && retryScheduledAt(checkIns, m.failure.resetsAt)
                )}
              />
            );
          case 'check_in':
            return <CheckInLine key={m.id} message={m} arrived={arrived} />;
          case 'from_agent':
          case 'sent_to_agent':
            // Only an import conversation's lines stand alone (`buildChatItems`).
            return <ConnectorBubble key={m.id} message={m} arrived={arrived} />;
          case 'note':
            return (
              <NoteLine
                key={m.id}
                message={m}
                arrived={arrived}
                agent={rowAgent}
                onOpenPeer={m.peer && existing.has(m.peer.id) ? onOpenAgent : undefined}
              />
            );
          case 'changes':
            return (
              <ChangeCard
                key={m.id}
                message={m}
                arrived={arrived}
                agent={m.id === liveCopyCard ? copyAgent : undefined}
                live={m.id === liveCopyCard}
                owner={rowAgent}
                newestResult={newestResult.has(m.id)}
                onAskForChanges={askForChanges}
              />
            );
          case 'session':
            return <SessionCard key={m.id} message={m} agent={rowAgent} arrived={arrived} />;
          default:
            return null;
        }
      }),
    [
      items,
      startIndex,
      agent.engine,
      projectsCtx?.openProject,
      arrivedAt,
      existing,
      onOpenAgent,
      livePeerLines,
      similar,
      jumpTo,
      drivingId,
      aliases,
      rowAgent,
      failed,
      sending,
      retry,
      queuedId,
      interruptNow,
      driven,
      colorOf,
      streaming,
      rowsPaused,
      onAnswer,
      onSignIn,
      retryId,
      retryLast,
      retryLater,
      checkIns,
      liveCopyCard,
      copyAgent,
      newestResult,
      askForChanges,
    ]
  );
  // The working line goes in after: what it's doing changes every step, and
  // must not rebuild the history around it.
  // "Setting up your team", at its place in the history (never pinned under
  // the newest line), then the working line.
  const setupRow = setupHere && setupAt >= startIndex && (
    <TeamSetupCard key="team-setup" view={setupHere} chief={agent.name} onOpenAgent={onOpenAgent} />
  );
  const withSetup = withIndicatorAt(setupAt - startIndex, history, setupRow);
  const workingAt = Math.max(0, queuedFrom - startIndex);
  const rows = withIndicatorAt(
    setupRow && setupAt - startIndex <= workingAt ? workingAt + 1 : workingAt,
    withSetup,
    indicator.mounted && (
      <WorkingIndicator
        key="working"
        activity={activity}
        work={work}
        agent={rowAgent}
        place={inRoom && <RoomWorkingPlace roomId={inRoom} onOpenRoom={onOpenAgent} />}
        entering={indicator.entering}
        leaving={indicator.leaving}
        onExited={indicator.onExited}
      />
    )
  );

  return (
    <AccentScopeProvider scope={accentScope}>
      <AgentGalleryProvider messages={shown} agentOf={galleryAgentOf}>
        <section
          ref={sectionRef}
          className="agent-chat"
          data-color={agent.color}
          data-dropping={dropping || undefined}
          data-takeover-terminal={terminalShown || undefined}
          aria-label={`Conversation with ${agent.name}`}
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
            {compact ? (
              <LiveAgentSwitcher
                currentId={agent.id}
                title={title}
                label={`${agent.name}. Switch agent`}
                onOpenAgent={onOpenAgent}
                onGoHome={compact.onGoHome}
              />
            ) : (
              <div className="agent-chat__title">
                {title}
                {/* Not in the compact switcher: it's a button already. */}
                <AgentProjectChip agent={agent} />
              </div>
            )}
            <div className="agent-chat__actions">
              {/* Nothing to schedule or pick a model for until Claude Code is here. */}
              {engineReady && (
                <>
                  <AgentSchedulePopover
                    agent={agent}
                    open={scheduleOpen}
                    onOpenChange={openSchedule}
                    startWhen={scheduleWhen}
                  />
                </>
              )}
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
                    title="Agent actions"
                    aria-label={`Actions for ${agent.name}`}
                  />
                )}
              >
                <AgentActionItems
                  agent={agent}
                  kind="dropdown"
                  onSchedule={engineReady ? () => setScheduleOpen(true) : undefined}
                  onFiles={() => setFilesOpen(true)}
                  {...actions}
                />
                {/* Nothing to pick a model for until its engine is here. */}
                {engineReady && <AgentModelItems agent={agent} />}
              </Dropdown>
              <AgentFilesModal
                agent={agent}
                isOpen={filesOpen}
                onClose={() => setFilesOpen(false)}
              />
              <RememberModal
                key={remembering?.id ?? 'none'}
                agent={agent}
                message={remembering}
                onClose={() => setRemembering(null)}
              />
            </div>
          </header>

          {/* Unmounted while the chat shows (a hidden xterm would fit itself to
            nothing); showing it again replays the session's scrollback. */}
          {takeover && terminalShown && (
            <div className="agent-chat__takeover">
              <TakeoverTerminal takeover={takeover} />
            </div>
          )}

          <div className="agent-chat__scroll" ref={scrollRef} onScroll={onScroll}>
            <div
              className="agent-chat__messages"
              ref={messagesRef}
              data-greeting={(greetingOnly && engineReady) || undefined}
            >
              {items.length === 0 ? (
                <div className="agent-chat__empty">
                  <AgentAvatar name={agent.name} color={agent.color} size="hero" selected />
                  <p className="agent-chat__empty-name">{agent.name}</p>
                  {agent.isMain ? (
                    <>
                      <p className="agent-chat__empty-role">
                        Tell me what you’re working on and I’ll put a team together. I create
                        agents, hand them the work, and bring you what comes back.
                      </p>
                      {engineReady && chiefStarters}
                    </>
                  ) : (
                    <>
                      {agent.role && <p className="agent-chat__empty-role">{agent.role}</p>}
                      <p className="agent-chat__empty-hint">
                        It remembers what you tell it. Anything risky comes to you first, for you to
                        Allow or Deny.
                      </p>
                      <TextButton tabIndex={0} onClick={() => actions.onEdit(agent)}>
                        View instructions
                      </TextButton>
                      {engineReady && templateStarters}
                      {engineReady && !template && (
                        <div className="agent-chat__starters">
                          {AGENT_STARTERS.map((text) => (
                            <Button
                              key={text}
                              tabIndex={0}
                              variant="secondary"
                              onClick={() => sendStarter(text)}
                            >
                              {text}
                            </Button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                rows
              )}
              {/* The Chief spoke first (its stored greeting); the ways in sit
              under it until the user says something. */}
              {greetingOnly && engineReady && chiefStarters}
              {/* A ready-made agent the Chief just made: only "Created by" so
              far, so its own starters sit under it until the user speaks. */}
              {templateFirstOpen && engineReady && templateStarters}
              {items.length > 0 && (
                <FreshHint agent={agent} onStartFresh={() => actions.onStartFresh(agent)} />
              )}
              {items.length === 0 && indicator.mounted && (
                <WorkingIndicator
                  activity={activity}
                  work={agent.status.work}
                  agent={rowAgent}
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
                onClick={scrollToBottom}
                aria-label="Jump to latest"
                title="Jump to latest"
              />
            )}

            {/* This conversation's state, in one stack in a fixed order: you're
              driving it, an import, what its engine can't do, a key in the
              draft, dictation blocked. Two at most; the rest fold. */}
            <ConversationBars
              bars={[
                // The phone is driving a tab in this Mac's Chrome: said in every conversation.
                { id: 'phoneSignin', node: <PhoneSigninBar /> },
                {
                  id: 'waiting',
                  node: <WaitingForYouBar agent={agent} messages={messages} />,
                },
                {
                  id: 'takeover',
                  node: (
                    <TakeoverBanner
                      agent={agent}
                      terminalShown={terminalShown}
                      onToggleTerminal={toggleTerminal}
                    />
                  ),
                },
                { id: 'import', node: agent.isMain && <ImportTalkBar /> },
                {
                  // What the import left to do opens its checklist, not the
                  // requests panel: those logins are on the card (and left out
                  // of the requests bar's counts through `shownRequestIds`).
                  id: 'setup',
                  node: setupHere && !setupHere.complete && (
                    <ConversationBar
                      state="waiting"
                      data-testid="team-setup-bar"
                      title={SETUP_BAR_TITLE}
                      detail={progressLine(setupHere)}
                      actions={
                        <Button size="compact" variant="secondary" onClick={showTeamSetup}>
                          Continue
                        </Button>
                      }
                    />
                  ),
                },
                {
                  id: 'requests',
                  node: engineReady && (
                    <AgentRequestsBar
                      agent={agent}
                      peerIds={peerIds}
                      askers={foreignOwners}
                      shownRequestIds={shownRequestIds}
                      onOpenAgent={onOpenAgent}
                      setup={setupBarTarget}
                    />
                  ),
                },
                {
                  id: 'engine',
                  node: engineReady && cantAsk && (
                    <ConversationBar
                      data-testid="agent-cant-ask"
                      title={`${ENGINE_LABEL[agent.engine]} can’t stop to ask you here`}
                      detail={`Anything that needs your OK is refused instead. Updating ${ENGINE_LABEL[agent.engine]} fixes this.`}
                    />
                  ),
                },
                {
                  id: 'secret',
                  node: engineReady && (
                    <AgentSecretHint
                      agentId={agent.id}
                      agentName={agent.name}
                      draft={draft}
                      setDraft={setDraft}
                    />
                  ),
                },
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

            {engineReady ? (
              <form
                className="agent-composer"
                data-dictation={dictation.phase}
                data-has-attachments={
                  staged.length > 0 || quotes.length > 0 || revising !== null || undefined
                }
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                {mentionPicker.menu}
                <ComposerRevising revising={revising} onRemove={() => setRevising(null)} />
                <ComposerQuotes quotes={quotes} onRemove={removeQuote} />
                <ComposerAttachments items={staged} onRemove={attachments.remove} />
                <TextArea
                  ref={inputRef}
                  className="agent-composer__input"
                  rows={1}
                  value={draft}
                  placeholder={dictating ? '' : `Message ${agent.name}`}
                  readOnly={dictating}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    mentionPicker.sync();
                  }}
                  onSelect={mentionPicker.sync}
                  onPaste={attachments.onPaste}
                  onKeyDown={(e) => {
                    if (dictation.onComposerKeyDown(e)) return;
                    if (mentionPicker.onKeyDown(e)) return;
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send(e.metaKey);
                    } else if (e.key === 'Escape' && onEscape?.()) {
                      e.preventDefault();
                    } else if (e.key === 'Escape' && working && !canSend) {
                      e.preventDefault();
                      if (escArmed) {
                        setEscArmed(false);
                        void onStop();
                      } else {
                        setEscArmed(true);
                      }
                    }
                  }}
                  aria-label={`Message ${agent.name}`}
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
                    <IconButton
                      tabIndex={0}
                      variant="ghost"
                      className="agent-composer__attach"
                      icon={<PaperclipIcon size={14} />}
                      onClick={pickFiles}
                      aria-label="Attach files"
                      title="Attach files, or paste or drop them here"
                    />
                  )}
                  {/* Its own row above the text, so a long hint never squeezes it. */}
                  {escArmed && working && !canSend && !dictating ? (
                    <span className="agent-composer__hint" data-armed role="status">
                      Esc again to stop {agent.name}
                    </span>
                  ) : (
                    busy &&
                    canSend &&
                    !dictating && (
                      <span className="agent-composer__hint" aria-hidden>
                        ↵ queues · ⌘↵ interrupts and sends now
                      </span>
                    )
                  )}
                  <div className="agent-composer__actions">
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
                        dictating
                          ? 'Stop dictating (Esc to discard)'
                          : 'Dictate (⌘⇧D, or hold ⌥Space)'
                      }
                    />
                    {working && !canSend && !dictating ? (
                      <IconButton
                        tabIndex={0}
                        variant="secondary"
                        className="agent-composer__stop"
                        data-armed={escArmed || undefined}
                        icon={<span className="agent-composer__stop-square" aria-hidden />}
                        onClick={() => void onStop()}
                        aria-label={`Stop ${agent.name}`}
                        title="Stop (Esc twice)"
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
                        title={
                          busy
                            ? `Queue it: ${agent.name} reads it when it finishes (↵). Interrupt and send now: ⌘↵`
                            : 'Send'
                        }
                      />
                    )}
                  </div>
                </div>
              </form>
            ) : (
              <div className="agent-composer agent-composer--blocked" role="status">
                <InfoIcon size={14} className="agent-composer__blocked-icon" />
                <span className="agent-composer__blocked-text">
                  {engineInstalled
                    ? `${agent.name} runs on ${ENGINE_LABEL[agent.engine]}, which is signed out on this Mac.`
                    : `${agent.name} runs on ${ENGINE_LABEL[agent.engine]}, which isn’t installed on this Mac yet.`}
                </span>
                <Button tabIndex={0} variant="primary" onClick={onSetUpEngine}>
                  {engineInstalled ? 'Sign in' : `Set up ${ENGINE_LABEL[agent.engine]}`}
                </Button>
              </div>
            )}
          </div>

          {quoting.anchor && (
            <Button
              size="compact"
              className="agent-chat__quote"
              style={{ top: quoting.anchor.top, left: quoting.anchor.left }}
              // Keep the selection: a mousedown here would otherwise clear it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => quoting.quote()}
            >
              Quote <kbd className="agent-chat__kbd">⌘L</kbd>
            </Button>
          )}

          <div className="agent-chat__drop" aria-hidden={!dropping}>
            <div className="agent-chat__drop-label">
              <span className="agent-chat__drop-icon">
                <PaperclipIcon size={18} />
              </span>
              Drop files for {agent.name}
            </div>
          </div>
        </section>
      </AgentGalleryProvider>
    </AccentScopeProvider>
  );
});

/** A one-time check-in already waits for that reset: the retry is scheduled. */
function retryScheduledAt(checkIns: Agent['checkIns'], at: number): boolean {
  return (checkIns ?? []).some((c) => !c.repeat && !c.paused && Math.abs(c.nextAt - at) < 120_000);
}

/** The rows, with `extra` (if any) slotted in before row `at`. */
function withIndicatorAt(at: number, rows: ReactNode[], extra: ReactNode): ReactNode[] {
  if (!extra) return rows;
  return [...rows.slice(0, at), extra, ...rows.slice(at)];
}
