/**
 * Agents mode: the home sidebar lists your agents instead of your projects,
 * and the rest of the window is the conversation with the one you picked.
 * Every agent is a Claude Code session on this Mac; the Chief of Staff
 * manages the rest.
 *
 * Switching agents keeps the current conversation on screen until the next
 * one's messages are in, so a switch is one swap rather than a blank beat.
 *
 * Keys: ⌘N new agent; ⌥⌘↑ / ⌥⌘↓ or ⌘[ / ⌘] previous / next agent; ⌘J the
 * next agent that needs you (a card, or a turn that didn't finish); ⌘F
 * search, Esc to put it away; Esc twice in an empty composer stops a working
 * agent (AgentChat); ⌘K "Open <agent>", "Stop <agent>", "What's in flight"
 * (the cross-agent overview, also the "Needs you · N" row at the top of the
 * agent list while anything does), Allow / Deny for the oldest card waiting
 * on you, and the open agent's own actions (Edit, Pin, Mute, Hide, Mark as
 * unread, Start fresh, Open project, Delete).
 *
 * @module components/agents/AgentsView
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { HomeSidebar } from '../workspace/HomeSidebar';
import { AgentsSidebar, AgentsSidebarActions, InFlightBell, RoutinesRow } from './AgentsSidebar';
import { AgentsSearchPopover, AgentsTopSearch } from './AgentsSearchBox';
import { EngineSignInModal, type EngineSetup } from './EngineSignInModal';
import { AgentChat } from './AgentChat';
import { PaneBoundary, SidebarBoundary } from './AgentsErrorBoundary';
import { AgentsTeamView } from './AgentsTeamView';
import { AgentBriefingModal } from './AgentWorkDetail';
import { AgentsRoutinesView, type BulkAsk } from './AgentsRoutinesView';
import { ROUTINES_ID } from '../../lib/agentDesk';
import { menuOwnsShortcuts, onMenuAction, reportMenuContext } from '../../lib/nativeMenu';
import { AgentEditorModal, type EditorTab } from './AgentEditorModal';
import { AgentProjectsProvider } from './AgentProject';
import { TakeoverProvider, useTakeover } from './AgentTakeover';
import { OpenReachContext } from './openReach';
import { ImportAgentsModal, type ImportPath } from './ImportAgentsModal';
import { AgentAppsModal } from './AgentAppsModal';
import { AgentOnItsOwnModal } from './AgentOnItsOwn';
import { AgentRecipeModal } from './AgentRecipeModal';
import { useRecipeDrop } from './useRecipeDrop';
import { recipeTitle } from '../../lib/agentRecipe';
import { onItsOwnTitle } from '../../lib/agentOnItsOwn';
import { ChiefIdeasModal } from './ChiefIdeasModal';
import { TeamLoginsModal } from './TeamLogins';
import { BrowserSetupModal } from './TeamSetupReach';
import { ProjectActionConfirmModal } from '../dashboard/ProjectActionConfirmModal';
import { AccentScope } from '../../contexts/AccentScopeContext';
import { Spinner } from '../primitives/Spinner';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import {
  answerApproval,
  canTakeOver,
  deleteAgent,
  focusAgent,
  markAgentUnread,
  needsAttention,
  needsYou,
  noEngineInstalled,
  sortAgents,
  stopAgent,
  TEAM_ID,
  updateAgent,
  type Agent,
  type AgentEngine,
  type SearchHit,
} from '../../lib/agents';
import {
  getAgentsSnapshot,
  loadMessages,
  loadRoomMessages,
  openConversation,
  readChat,
  refreshAgents,
  refreshRooms,
  startConversation,
  useAgentsList,
  useAgentsSelector,
  useRoomsList,
} from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useOpenModal } from '../../contexts/ModalContext';
import { ROLE_TEMPLATES } from '../../lib/agentTemplates';
import type { ChiefIdea } from '../../lib/chiefIdeas';
import { useAgentsIntents } from '../../commands/useAgentsCommands';
import { useCommands } from '../../commands/useCommands';
import { useAgentKeyShortcuts } from '../../hooks/useAgentKeyShortcuts';
import {
  AgentsModeIcon,
  BellIcon,
  BellOffIcon,
  CheckIcon,
  CloseIcon,
  CollaboratorsIcon,
  CommentIcon,
  EditFieldIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  LockedIcon,
  PinIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
  UploadIcon,
  TerminalIcon,
} from '@/components/icons';
import { useAgentProjects } from './AgentProject';
import { AccountSwitcher } from './AccountSwitcher';
import { AgentsUsageView } from './AgentsUsageView';
import { USAGE_ID } from '../../lib/agentAccounts';
import { RoomChat } from './RoomChat';
import { RoomEditorModal } from './RoomEditorModal';
import { AgentPreviewPane } from './AgentPreviewPane';
import { AgentBrowserPane } from './AgentBrowserLive';
import {
  AgentPreviewProvider,
  useAgentPreview,
  useAgentPreviewRequest,
} from './AgentPreviewContext';
import type { AgentPreviewServer } from '../../lib/agentPreview';
import { useRoomRows, type RoomActions } from './AgentRoomParts';
import {
  deleteRoom,
  focusRoom,
  roomIdOf,
  roomKey,
  sortRooms,
  updateRoom,
  type Room,
} from '../../lib/agentRooms';
import { kbd } from '../../lib/shortcuts';
import { needsYouCount as countNeedsYou } from '../../../packages/companion-protocol/src/attention';
import { useResumableTeamSetup, useTeamSetup, withoutHeldLogins } from '../../lib/teamSetup';

const SELECTED_KEY = 'shipstudio.agents.selected';

function readSelected(): string | null {
  try {
    // "What's in flight" (the sidebar’s bell, or ⌘K) is a detour, never where Agents reopens.
    const id = localStorage.getItem(SELECTED_KEY);
    return id === TEAM_ID || id === USAGE_ID || id === ROUTINES_ID ? null : id;
  } catch {
    return null;
  }
}

function writeSelected(id: string) {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    /* per-viewer convenience only */
  }
}

interface AgentsViewProps {
  isCompact: boolean;
  sidebarProps: Omit<ComponentProps<typeof HomeSidebar>, 'activeNav' | 'listContent'>;
  /** The window's dev servers: the preview pane starts sites through them. */
  previewServer?: AgentPreviewServer;
}

/** Leaving for a project (a chip, a change card) goes the way the sidebar's project rows do. */
export function AgentsView(props: AgentsViewProps) {
  return (
    <AgentProjectsProvider onOpenProject={props.sidebarProps.onSelectProject}>
      <TakeoverProvider>
        <AgentPreviewProvider>
          <AgentsModeView {...props} />
        </AgentPreviewProvider>
      </TakeoverProvider>
    </AgentProjectsProvider>
  );
}

/** The open chat's composer; a no-op while none is on screen. */
function focusComposer() {
  document.querySelector<HTMLElement>('.agent-composer__input')?.focus({ preventScroll: true });
}

function AgentsModeView({ isCompact, sidebarProps, previewServer }: AgentsViewProps) {
  // Slices, not the whole store: a reply streaming anywhere must not re-render the view.
  const agents = useAgentsList();
  const loaded = useAgentsSelector((s) => s.loaded);
  const error = useAgentsSelector((s) => s.error);
  const engines = useAgentsSelector((s) => s.engines);
  const { showToast } = useOptionalToast();
  const takeover = useTakeover();
  const [selectedId, setSelectedId] = useState<string | null>(readSelected);
  const [editor, setEditor] = useState<{
    open: boolean;
    agent: Agent | null;
    tab?: EditorTab;
    /** Creating: the ready-made agent it opens on. */
    template?: string;
    /** Opens scrolled to "What it can reach" (a connected login card's link). */
    reach?: boolean;
  }>({
    open: false,
    agent: null,
  });
  const [importOpen, setImportOpen] = useState(false);
  /** The path the palette asked for, for this opening. */
  const [importPath, setImportPath] = useState<ImportPath | null>(null);
  const [appsOpen, setAppsOpen] = useState(false);
  /** The agent the apps dialog was opened for: the one ticked to start with. */
  const [appsFor, setAppsFor] = useState<string | null>(null);
  /** "What can it do on its own?" is open for this agent. */
  const [onItsOwnFor, setOnItsOwnFor] = useState<string | null>(null);
  /** Its recipe is being shared. */
  const [recipeFor, setRecipeFor] = useState<string | null>(null);
  // "What it was told" (the … menu): the newest briefing, read-only.
  const [briefingFor, setBriefingFor] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  /** The message a search result asked a chat to show; only that agent's chat takes it. */
  const [jump, setJump] = useState<{ agentId: string; messageId: string } | null>(null);

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const rooms = useRoomsList();
  const roomRows = useRoomRows(agentsById);
  const roomsLoaded = useAgentsSelector((s) => s.roomsLoaded);
  // A room (`room:<id>`), if that's what's open and it still exists.
  const openRoomId = roomIdOf(selectedId);
  const room = openRoomId ? (rooms.find((r) => r.id === openRoomId) ?? null) : null;
  const [roomEditor, setRoomEditor] = useState<{ open: boolean; room: Room | null }>({
    open: false,
    room: null,
  });
  const [deletingRoom, setDeletingRoom] = useState<Room | null>(null);
  // "What's in flight" (the sidebar’s bell or ⌘K), else the last agent you had open, else the Chief of Staff.
  const teamOpen = selectedId === TEAM_ID;
  // Usage (the sidebar's usage row, ⌘K, a chat's account chip): a detour too.
  const usageOpen = selectedId === USAGE_ID;
  // Routines (the sidebar's Routines row, ⌘K): every agent's routines in one list.
  const routinesOpen = selectedId === ROUTINES_ID;
  const roomOpen = room !== null;
  const selected =
    teamOpen || usageOpen || routinesOpen || roomOpen
      ? null
      : (selectedId && agentsById.get(selectedId)) ||
        agents.find((a) => a.isMain) ||
        sortAgents(agents)[0] ||
        null;

  // The conversation on screen: the selected one once its messages are in,
  // until then whichever was there before.
  const [shownId, setShownId] = useState<string | null>(null);
  const selectedKey = selected?.id ?? null;
  const selectedReady = useAgentsSelector(
    (s) => selectedKey !== null && s.messages[selectedKey] !== undefined
  );
  if (selectedReady && selectedKey !== null && shownId !== selectedKey) setShownId(selectedKey);
  const shown = (shownId && agentsById.get(shownId)) || null;

  // Opening an agent on purpose (a dialog, ⌘K, ⌘J, a notification) puts you
  // in its composer. A chat focuses it when it mounts, but a dialog closing
  // restores focus to its trigger, and an agent already on screen doesn't
  // mount again; so this asks once more, a frame later, and again when the
  // chat it asked for arrives.
  const [focusAsk, setFocusAsk] = useState(0);
  const openAgent = useCallback((id: string) => {
    setSelectedId(id);
    setFocusAsk((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!focusAsk) return;
    const frame = requestAnimationFrame(focusComposer);
    return () => cancelAnimationFrame(frame);
  }, [focusAsk, shown?.id]);

  // A room open: its lines don't count as unread while it's in front.
  useEffect(() => {
    if (!room) return;
    writeSelected(roomKey(room.id));
    void focusRoom(room.id);
    if (!getAgentsSnapshot().messages[roomKey(room.id)]) void loadRoomMessages(room.id);
  }, [room?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A room that's gone (deleted here or elsewhere): back to the Chief.
  if (openRoomId && roomsLoaded && !room) setSelectedId(null);

  useEffect(() => {
    if (!selected) {
      // On "What's in flight" no conversation is on screen, so replies still count as unread.
      if (teamOpen || usageOpen) void focusAgent(null);
      return;
    }
    writeSelected(selected.id);
    void focusAgent(selected.id);
    readChat(selected.id);
  }, [selected?.id, teamOpen, usageOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  // On launch the chat Agents reopens on is known before the list of agents
  // is: its reads start now, beside the list's, rather than after it.
  useEffect(() => {
    const id = readSelected();
    if (id && roomIdOf(id) === null) readChat(id);
  }, []);

  // Leaving Agents mode: nothing is on screen any more, so new replies count as unread.
  useEffect(() => () => void focusAgent(null), []);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        await refreshAgents();
      } catch (err) {
        showToast(formatCommandError(asCommandError(err)), 'error');
      }
    },
    [showToast]
  );

  const openNew = useCallback(
    (template?: string) => setEditor({ open: true, agent: null, template }),
    []
  );
  const openImport = useCallback(() => {
    setImportPath(null);
    setImportOpen(true);
  }, []);
  const openImportFrom = useCallback((from?: 'otherApp' | 'paste') => {
    setImportPath(from ?? null);
    setImportOpen(true);
  }, []);
  const openReach = useCallback(
    (agentId: string) => {
      const agent = agents.find((a) => a.id === agentId);
      if (agent) setEditor({ open: true, agent, reach: true });
    },
    [agents]
  );
  const openApps = useCallback((agentId?: string | null) => {
    setAppsFor(agentId ?? null);
    setAppsOpen(true);
  }, []);
  const openAppsForAll = useCallback(() => openApps(), [openApps]);
  const openInFlight = useCallback(() => setSelectedId(TEAM_ID), []);
  const openUsage = useCallback(() => setSelectedId(USAGE_ID), []);
  // ⌘K "Pause all routines…" opens Routines on that question.
  const [routinesAsk, setRoutinesAsk] = useState<BulkAsk | null>(null);
  const openRoutines = useCallback((ask?: BulkAsk) => {
    setRoutinesAsk(ask ?? null);
    setSelectedId(ROUTINES_ID);
  }, []);
  const clearRoutinesAsk = useCallback(() => setRoutinesAsk(null), []);
  /** New agent's "Ask your Chief of Staff": the request, drafted in the Chief's composer. */
  const [prefill, setPrefill] = useState<{ agentId: string; text: string; n: number } | null>(null);
  // Delivered once: leaving that chat and coming back doesn't type it again.
  if (prefill && selectedId !== prefill.agentId) setPrefill(null);
  /** "More ideas…" (and ⌘K): the gallery of things to ask the Chief. */
  const openModal = useOpenModal();
  const openIdeas = useCallback(() => openModal('chiefIdeas'), [openModal]);
  const openLogins = useCallback(() => openModal('teamLogins'), [openModal]);
  const openBrowser = useCallback(() => openModal('agentBrowser'), [openModal]);
  const openPhone = useCallback(() => openModal('phone'), [openModal]);
  /** A picked idea: the Chief's chat, with its brief typed out. */
  const pickIdea = useCallback(
    (idea: ChiefIdea) => {
      const chief = agents.find((a) => a.isMain);
      if (!chief) return;
      setPrefill({ agentId: chief.id, text: idea.text, n: Date.now() });
      setSelectedId(chief.id);
    },
    [agents]
  );
  // The sidebar's top field searches conversations. With no sidebar to hold
  // it (compact, or the rail collapsed) it comes up over the chat instead.
  const popoverSearch = isCompact || sidebarProps.isSidebarHidden;
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** Claude Code's terminal: installing (then signing in), or only signing in. */
  const [engineSetup, setEngineSetup] = useState<EngineSetup | null>(null);
  /** The search hit last opened, marked in the results. */
  const [currentHit, setCurrentHit] = useState<string | null>(null);
  const [stopping, setStopping] = useState<Agent | null>(null);
  const searchOpen = query.trim().length > 0 || (popoverSearch && popoverOpen);
  const closeSearch = useCallback(() => {
    setPopoverOpen(false);
    setQuery('');
    focusComposer();
  }, []);
  // Focus lands before the next key does: the field is there (or mounted
  // synchronously) by the time this returns, so nothing typed is lost.
  const focusSearch = useCallback(() => {
    if (popoverSearch) flushSync(() => setPopoverOpen(true));
    searchRef.current?.focus({ preventScroll: true });
    searchRef.current?.select();
  }, [popoverSearch]);
  const search = useMemo(() => ({ query, setQuery, close: closeSearch }), [query, closeSearch]);
  // Picked by name: the agent was the answer, so search goes away. setQuery
  // rather than closeSearch, so the composer focus is openAgent's.
  const openAgentByName = useCallback(
    (id: string) => {
      setPopoverOpen(false);
      setQuery('');
      openAgent(id);
    },
    [openAgent]
  );

  // ⌘F searches every conversation, wherever focus is in Agents mode. Esc
  // anywhere puts search away, unless something on top (a dialog, a menu,
  // the composer) already took it.
  const searchKeys = useRef({ searchOpen, closeSearch, focusSearch });
  useEffect(() => {
    searchKeys.current = { searchOpen, closeSearch, focusSearch };
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { searchOpen, closeSearch, focusSearch } = searchKeys.current;
      if (e.key === 'Escape') {
        if (!searchOpen || e.defaultPrevented) return;
        if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
        e.preventDefault();
        closeSearch();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f')
        return;
      // The macOS menu bar owns ⌘F (Edit → Search Conversations…).
      if (menuOwnsShortcuts()) return;
      e.preventDefault();
      focusSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  /** The composer's Esc closes search first, rather than stopping the agent. */
  const escapeSearch = useCallback(() => {
    if (!searchKeys.current.searchOpen) return false;
    searchKeys.current.closeSearch();
    return true;
  }, []);

  /**
   * Open an agent's chat on one line. A line said in another of its
   * conversations opens that conversation first, then scrolls to it.
   */
  const openMessage = useCallback((agentId: string, messageId: string, conversation?: string) => {
    if (conversation && getAgentsSnapshot().viewing[agentId] !== conversation) {
      void openConversation(agentId, conversation);
    }
    setSelectedId(agentId);
    setJump({ agentId, messageId });
  }, []);
  const openHit = useCallback(
    (hit: SearchHit) => {
      setCurrentHit(hit.messageId);
      if (hit.roomId) {
        setSelectedId(roomKey(hit.roomId));
        return;
      }
      openMessage(hit.agentId, hit.messageId, hit.conversation);
    },
    [openMessage]
  );
  const clearJump = useCallback(() => setJump(null), []);
  useAgentsIntents({
    onNewAgent: openNew,
    onImportAgents: openImportFrom,
    onApps: openAppsForAll,
    onOpenAgent: openAgent,
    onSearch: focusSearch,
    onIdeas: openIdeas,
    onLogins: openLogins,
    onBrowser: openBrowser,
    onShareRecipe: setRecipeFor,
    onRoutines: openRoutines,
  });
  // A recipe file dropped anywhere on the window (not on Import, which
  // reads it itself): its review card goes up in the Chief's chat.
  useRecipeDrop(!importOpen, (chiefId) => openAgent(chiefId));
  // Each agent's bound key opens it (outside text fields, dialogs and menus).
  useAgentKeyShortcuts(agents, openAgent);

  // The order you see in the sidebar, for previous / next.
  const order = sortAgents(agents).filter((a) => !a.hidden || showHidden || a.id === selected?.id);
  /** The next agent after the one open that needs you, wrapping; null if none does. */
  const nextNeedingYou = useCallback((): Agent | null => {
    const list = sortAgents(agents).filter((a) => !a.hidden);
    const from = list.findIndex((a) => a.id === selected?.id);
    for (let i = 1; i <= list.length; i++) {
      const a = list[(from + i + list.length) % list.length];
      if (needsAttention(a) && a.id !== selected?.id) return a;
    }
    return null;
  }, [agents, selected?.id]);
  const keys = useRef({ order, selected, openNew, nextNeedingYou, showToast });
  useEffect(() => {
    keys.current = { order, selected, openNew, nextNeedingYou, showToast };
  });

  // ⌘J, and ⌘[ / ⌘] (or ⌥↑ / ⌥↓) through the sidebar's order.
  const goNextNeedingYou = useCallback(() => {
    const next = keys.current.nextNeedingYou();
    // Said, so the key never seems broken.
    if (next) openAgent(next.id);
    else keys.current.showToast('No other agent needs you right now', 'info');
  }, [openAgent]);
  const stepAgent = useCallback((step: -1 | 1) => {
    const { order, selected } = keys.current;
    if (order.length === 0) return;
    const index = order.findIndex((a) => a.id === selected?.id);
    setSelectedId(order[(index + step + order.length) % order.length].id);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      // Leave every key alone while a dialog owns the keyboard.
      if (document.querySelector('[aria-modal="true"]')) return;
      // On macOS ⌘N, ⌘J, ⌘[ and ⌘] are the menu bar's (File, Go): it
      // answers them even with the preview focused, and only once.
      const menu = menuOwnsShortcuts();
      if (!menu && event.key.toLowerCase() === 'n' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        keys.current.openNew();
        return;
      }
      if (!menu && event.key.toLowerCase() === 'j' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        goNextNeedingYou();
        return;
      }
      const step =
        (event.altKey && event.key === 'ArrowUp') || (!menu && event.key === '[')
          ? -1
          : (event.altKey && event.key === 'ArrowDown') || (!menu && event.key === ']')
            ? 1
            : 0;
      if (step === 0) return;
      event.preventDefault();
      stepAgent(step);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goNextNeedingYou, stepAgent]);

  // The menu bar's Agents items (macOS). New Agent… is app-wide
  // (`useAgentsNavCommands`); these act on what's open here.
  const conversationOpen = Boolean(selected);
  useEffect(() => {
    reportMenuContext({ conversation: conversationOpen });
  }, [conversationOpen]);
  useEffect(() => () => reportMenuContext({ conversation: false }), []);
  const newConversationRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    newConversationRef.current =
      conversationOpen && selected ? () => void run(() => startConversation(selected.id)) : null;
  });
  useEffect(
    () =>
      onMenuAction((action) => {
        if (document.querySelector('[aria-modal="true"]')) return;
        if (action === 'next_needing_you') goNextNeedingYou();
        else if (action === 'prev_agent') stepAgent(-1);
        else if (action === 'next_agent') stepAgent(1);
        else if (action === 'find') searchKeys.current.focusSearch();
        else if (action === 'new_conversation') newConversationRef.current?.();
      }),
    [goNextNeedingYou, stepAgent]
  );

  // Logins "Setting up your team" holds live in its one card, not as an
  // amber row per imported agent (What's in flight leaves them out too).
  const setup = useResumableTeamSetup();
  const listed = useMemo(() => withoutHeldLogins(agents, setup), [agents, setup]);

  // What the "Needs you" row counts: the one number every surface shows
  // (the review bar, the phone's Home bar and tab badge, the Dock badge).
  // An agent whose only requests are the checklist's logins is counted once, there.
  const teamSetup = useTeamSetup();
  const needsYouCount = useMemo(() => countNeedsYou(agents, teamSetup), [agents, teamSetup]);

  // The oldest card waiting on you, on the first agent (sidebar order) with one.
  const waitingOn = sortAgents(listed).find((a) => !a.hidden && needsYou(a)) ?? null;
  const topCard = useAgentsSelector((s) =>
    waitingOn
      ? (s.messages[waitingOn.id] ?? []).find((m) => m.approval?.status === 'pending')
      : undefined
  );
  useEffect(() => {
    if (waitingOn && !getAgentsSnapshot().messages[waitingOn.id]) void loadMessages(waitingOn.id);
  }, [waitingOn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const answerTop = useCallback(
    (allow: boolean) => {
      if (!waitingOn || !topCard?.approval) return;
      answerApproval(waitingOn.id, topCard.approval.requestId, allow).catch((err: unknown) =>
        showToast(formatCommandError(asCommandError(err)), 'error')
      );
    },
    [waitingOn, topCard, showToast]
  );

  // Stable, so a status event re-renders only the sidebar row it changed.
  const actions = useMemo(
    () => ({
      onTogglePin: (a: Agent) => void run(() => updateAgent(a.id, { pinned: !a.pinned })),
      onToggleHidden: (a: Agent) => void run(() => updateAgent(a.id, { hidden: !a.hidden })),
      onToggleMuted: (a: Agent) => void run(() => updateAgent(a.id, { muted: !a.muted })),
      onMarkUnread: (a: Agent) => {
        const { order, selected } = keys.current;
        if (a.id === selected?.id) {
          // Step off it, or opening it again would mark it read straight away.
          const other = order.find((o) => o.id !== a.id);
          if (other) setSelectedId(other.id);
        }
        void run(() => markAgentUnread(a.id));
      },
      onEdit: (a: Agent) => setEditor({ open: true, agent: a }),
      onDelete: setDeleting,
      // A new conversation leaves nothing behind (the others stay in the
      // switcher), so it needs no confirm, and never waits on a turn.
      onStartFresh: (a: Agent) => {
        setSelectedId(a.id);
        void run(() => startConversation(a.id));
      },
      onTakeOver: takeover?.takeOver,
      onHandBack: takeover?.handBack,
      onOnItsOwn: (a: Agent) => setOnItsOwnFor(a.id),
      onShareRecipe: (a: Agent) => setRecipeFor(a.id),
      onWhatItWasTold: (a: Agent) => setBriefingFor(a),
    }),
    [run, takeover]
  );
  const agentProjects = useAgentProjects();

  const roomActions = useMemo<RoomActions>(
    () => ({
      onEditRoom: (r: Room) => setRoomEditor({ open: true, room: r }),
      onToggleRoomMuted: (r: Room) =>
        void run(async () => {
          await updateRoom(r.id, { muted: !r.muted });
          await refreshRooms();
        }),
      onDeleteRoom: setDeletingRoom,
    }),
    [run]
  );
  const openNewRoom = useCallback(() => setRoomEditor({ open: true, room: null }), []);

  useCommands(
    () => [
      ...(agents.length >= 2
        ? [
            {
              id: 'rooms.new',
              title: 'New room…',
              icon: <CollaboratorsIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'group', 'chat', 'room', 'team', 'together', 'everyone'],
              run: openNewRoom,
            },
          ]
        : []),
      ...sortRooms(rooms).map((r) => ({
        id: `rooms.open.${r.id}`,
        title: `Open ${r.name}`,
        icon: <CollaboratorsIcon size={14} />,
        category: 'navigation' as const,
        keywords: ['room', 'group', 'agents', 'chat'],
        run: () => openAgent(roomKey(r.id)),
      })),
      ...(room
        ? [
            {
              id: 'rooms.edit',
              title: `${room.name}: members and name…`,
              icon: <EditIcon size={14} />,
              category: 'action' as const,
              keywords: ['room', 'members', 'add', 'remove', 'rename', 'lead', 'leave'],
              run: () => roomActions.onEditRoom(room),
            },
            {
              id: 'rooms.mute',
              title: `${room.muted ? 'Unmute' : 'Mute'} ${room.name}`,
              icon: room.muted ? <BellIcon size={14} /> : <BellOffIcon size={14} />,
              category: 'action' as const,
              keywords: ['room', 'notifications', 'quiet', 'unread'],
              run: () => roomActions.onToggleRoomMuted(room),
            },
            {
              id: 'rooms.delete',
              title: `Delete ${room.name}…`,
              icon: <TrashIcon size={14} />,
              category: 'action' as const,
              keywords: ['room', 'remove', 'delete', 'leave'],
              run: () => roomActions.onDeleteRoom(room),
            },
          ]
        : []),
      {
        id: 'agents.nextNeedingYou',
        title: 'Next agent that needs you',
        icon: <AgentsModeIcon size={14} />,
        category: 'navigation',
        shortcut: kbd('mod', 'J'),
        keywords: ['agents', 'approval', 'waiting', 'failed', 'unread', 'jump'],
        when: () => agents.some((a) => !a.hidden && needsAttention(a)),
        run: () => {
          const next = nextNeedingYou();
          if (next) openAgent(next.id);
        },
      },
      ...(order.length > 1
        ? [
            {
              id: 'agents.previous',
              title: 'Previous agent',
              icon: <AgentsModeIcon size={14} />,
              category: 'navigation' as const,
              shortcut: kbd('mod', '['),
              keywords: ['agents', 'up', 'back', 'sidebar'],
              run: () => stepAgent(-1),
            },
            {
              id: 'agents.next',
              title: 'Next agent',
              icon: <AgentsModeIcon size={14} />,
              category: 'navigation' as const,
              shortcut: kbd('mod', ']'),
              keywords: ['agents', 'down', 'forward', 'sidebar'],
              run: () => stepAgent(1),
            },
          ]
        : []),
      ...(waitingOn && topCard?.approval
        ? [
            {
              id: 'agents.allowTop',
              title: `Allow ${waitingOn.name}: ${topCard.approval.title}`,
              icon: <CheckIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'approve', 'approval', 'yes', topCard.approval.detail],
              run: () => answerTop(true),
            },
            {
              id: 'agents.denyTop',
              title: `Deny ${waitingOn.name}: ${topCard.approval.title}`,
              icon: <CloseIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'decline', 'approval', 'no', topCard.approval.detail],
              run: () => answerTop(false),
            },
          ]
        : []),
      ...(selected
        ? [
            {
              id: 'agents.memory',
              title: `Edit what ${selected.name} remembers…`,
              icon: <EditFieldIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'memory', 'remember', 'forget', 'claude.md', 'facts'],
              run: () => setEditor({ open: true, agent: selected, tab: 'memory' }),
            },
            {
              id: 'agents.reach',
              title: `What ${selected.name} can reach…`,
              icon: <LockedIcon size={14} />,
              category: 'action' as const,
              keywords: [
                'agents',
                'access',
                'logins',
                'connections',
                'revoke',
                'remove',
                'keys',
                'apps',
                'browser',
              ],
              run: () => setEditor({ open: true, agent: selected, reach: true }),
            },
          ]
        : []),
      // The open agent's own actions: everything in its … menu, by name.
      ...(selected
        ? [
            {
              id: 'agents.edit',
              title: `Edit ${selected.name}…`,
              icon: <EditIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'settings', 'instructions', 'role', 'model', 'rename'],
              run: () => actions.onEdit(selected),
            },
            {
              id: 'agents.pin',
              title: `${selected.pinned ? 'Unpin' : 'Pin'} ${selected.name}`,
              icon: <PinIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'pin', 'top', 'favourite'],
              run: () => actions.onTogglePin(selected),
            },
            {
              id: 'agents.mute',
              title: `${selected.muted ? 'Unmute' : 'Mute'} ${selected.name}`,
              icon: selected.muted ? <BellIcon size={14} /> : <BellOffIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'notifications', 'quiet', 'silence'],
              run: () => actions.onToggleMuted(selected),
            },
            {
              id: 'agents.hide',
              title: selected.hidden
                ? `Show ${selected.name} in the sidebar`
                : `Hide ${selected.name} from the sidebar`,
              icon: selected.hidden ? <EyeIcon size={14} /> : <EyeOffIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'hide', 'archive', 'sidebar'],
              run: () => actions.onToggleHidden(selected),
            },
            {
              id: 'agents.markUnread',
              title: `Mark ${selected.name} as unread`,
              icon: <CommentIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'unread', 'later', 'remind'],
              run: () => actions.onMarkUnread(selected),
            },
            ...(selected.project && agentProjects
              ? [
                  {
                    id: 'agents.openProject',
                    title: `Open ${selected.name}’s project`,
                    icon: <FolderIcon size={14} />,
                    category: 'action' as const,
                    keywords: ['agents', 'project', 'workspace', 'preview', 'folder'],
                    run: () => agentProjects.openProject(selected.project!),
                  },
                ]
              : []),
            ...(!selected.isMain
              ? [
                  {
                    id: 'agents.delete',
                    title: `Delete ${selected.name}…`,
                    icon: <TrashIcon size={14} />,
                    category: 'action' as const,
                    keywords: ['agents', 'remove', 'delete'],
                    // Asks first: the same confirm as the menu's Delete.
                    run: () => actions.onDelete(selected),
                  },
                ]
              : []),
          ]
        : []),
      // "What can <agent> do on its own?" for every agent, by name.
      ...agents
        .filter((a) => !a.hidden || a.id === selected?.id)
        .map((a) => ({
          id: `agents.onItsOwn.${a.id}`,
          title: onItsOwnTitle(a.name),
          icon: <ShieldCheckIcon size={14} />,
          category: 'action' as const,
          keywords: [
            'agents',
            'without asking',
            'permissions',
            'always allow',
            'rules',
            'allowed',
            'independence',
            'access',
          ],
          run: () => setOnItsOwnFor(a.id),
        })),
      // "Share <agent> as a recipe" for every agent but the Chief.
      ...agents
        .filter((a) => !a.isMain && (!a.hidden || a.id === selected?.id))
        .map((a) => ({
          id: `agents.shareRecipe.${a.id}`,
          title: recipeTitle(a.name),
          icon: <UploadIcon size={14} />,
          category: 'action' as const,
          keywords: ['agents', 'recipe', 'share', 'export', 'template', 'send', 'friend'],
          run: () => setRecipeFor(a.id),
        })),
      ...(selected
        ? [
            {
              id: 'agents.newConversation',
              // The same words as the … menu and the header's switcher.
              title: `New conversation with ${selected.name}`,
              icon: <PlusIcon size={14} />,
              category: 'action' as const,
              shortcut: kbd('mod', 'shift', 'N'),
              keywords: [
                'agents',
                'start fresh',
                'new chat',
                'thread',
                'reset',
                'clear',
                'context',
                'session',
              ],
              run: () => {
                void run(() => startConversation(selected.id));
              },
            },
          ]
        : []),
      // Take over is for the agent you're looking at, not one line per agent:
      // most people never take over, and seven terminal commands drown the
      // palette. Hand back stays for any agent you're driving (it's how you
      // get it back from anywhere).
      ...(takeover
        ? agents
            .filter((a) => a.takeover || a.id === selected?.id)
            .flatMap((a) =>
              a.takeover
                ? [
                    {
                      id: `agents.handBack.${a.id}`,
                      title: `Hand ${a.name} back`,
                      icon: <TerminalIcon size={14} />,
                      category: 'action' as const,
                      keywords: ['agents', 'take over', 'terminal', 'resume', 'give back'],
                      run: () => takeover.handBack(a),
                    },
                  ]
                : canTakeOver(a)
                  ? [
                      {
                        id: 'agents.takeOver',
                        title: `Take over ${a.name}`,
                        icon: <TerminalIcon size={14} />,
                        category: 'action' as const,
                        keywords: ['agents', 'terminal', 'conversation', 'drive', 'by hand'],
                        run: () => takeover.takeOver(a),
                      },
                    ]
                  : []
            )
        : []),
      ...agents
        .filter((a) => a.status.state !== 'idle')
        .map((a) => ({
          id: `agents.stop.${a.id}`,
          title: `Stop ${a.name}`,
          icon: <CloseIcon size={14} />,
          category: 'action' as const,
          keywords: ['agents', 'cancel', 'halt', 'kill', 'interrupt'],
          run: () => setStopping(a),
        })),
    ],
    [
      agents,
      waitingOn,
      topCard,
      answerTop,
      nextNeedingYou,
      openAgent,
      selected,
      actions,
      agentProjects,
      takeover,
      rooms,
      room,
      roomActions,
      openNewRoom,
      order.length,
      stepAgent,
    ]
  );

  const confirmStop = async () => {
    if (!stopping) return;
    const agent = stopping;
    setStopping(null);
    try {
      await stopAgent(agent.id);
    } catch (err) {
      showToast(formatCommandError(asCommandError(err)), 'error');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    await run(() => deleteAgent(deleting.id));
    if (selectedId === deleting.id) setSelectedId(null);
    setDeleteBusy(false);
    setDeleting(null);
    setEditor({ open: false, agent: null });
  };

  const toggleShowHidden = useCallback(() => setShowHidden((v) => !v), []);
  const signIn = useCallback(
    (engine: AgentEngine) => setEngineSetup({ engine, step: 'sign-in' }),
    []
  );

  const installEngine = useCallback(
    (engine: AgentEngine) => setEngineSetup({ engine, step: 'install' }),
    []
  );

  // Stable, so the memoised chat re-renders only for its own agent.
  const shownEngine = shown?.engine;
  const setUpShownEngine = useCallback(() => {
    if (!shownEngine) return;
    setEngineSetup({
      engine: shownEngine,
      // Codex can be installed and only need signing in.
      step: engines.find((e) => e.id === shownEngine)?.installed ? 'sign-in' : 'install',
    });
  }, [shownEngine, engines]);
  // An error line said its engine isn't on this Mac: install, whatever the
  // last check said (it may predate the engine going).
  const installShown = useCallback(() => {
    if (shownEngine) setEngineSetup({ engine: shownEngine, step: 'install' });
  }, [shownEngine]);
  const signInShown = useCallback(() => {
    if (shownEngine) signIn(shownEngine);
  }, [shownEngine, signIn]);
  const shownKey = shown?.id;
  const openShownApps = useCallback(() => openApps(shownKey), [openApps, shownKey]);
  const { onGoHome, onGoProjects } = sidebarProps;
  // The preview pane beside the chat (Preview on a card), for its agent.
  const previewCtx = useAgentPreview();
  const previewRequest = useAgentPreviewRequest();
  const previewAgent = previewRequest ? agentsById.get(previewRequest.agentId) : undefined;
  const preview = previewRequest?.browser
    ? previewAgent &&
      previewCtx && (
        <AgentBrowserPane
          key={`${previewRequest.agentId}:browser`}
          agent={previewAgent}
          turnStartedAt={previewRequest.browser.turnStartedAt}
          onClose={previewCtx.close}
        />
      )
    : previewRequest &&
      previewAgent &&
      previewCtx && (
        <AgentPreviewPane
          key={`${previewRequest.agentId}:${previewRequest.messageId}:${previewRequest.link ?? ''}`}
          agent={previewAgent}
          request={previewRequest}
          server={previewServer}
          onClose={previewCtx.close}
          onOpenInWorkspace={sidebarProps.onSelectProject}
        />
      );

  const chatCompact = useMemo(
    () => (isCompact ? { onGoHome, onGoProjects } : undefined),
    [isCompact, onGoHome, onGoProjects]
  );
  // Pages that aren't a chat stand in for the sidebar the same way.
  const pageCompact = useMemo(
    () => (isCompact ? { agents, onGoHome, onGoProjects } : undefined),
    [isCompact, agents, onGoHome, onGoProjects]
  );

  return (
    <OpenReachContext.Provider value={openReach}>
      <div className="app workspace workspace-home agents-mode">
        <div className={`projects-with-rail${isCompact ? ' is-compact' : ''}`} key="view-agents">
          {!isCompact && (
            <HomeSidebar
              {...sidebarProps}
              activeNav="agents"
              // Home belongs to the Projects side; here the one control is
              // What's in flight, with how many need you.
              navContent={
                <InFlightBell count={needsYouCount} current={teamOpen} onOpen={openInFlight} />
              }
              searchContent={
                <AgentsTopSearch
                  search={search}
                  field={searchRef}
                  collapsed={sidebarProps.isSidebarHidden}
                  onOpen={focusSearch}
                />
              }
              listActions={
                query.trim().length === 0 || popoverSearch ? (
                  <AgentsSidebarActions
                    agentCount={listed.length}
                    onNew={() => openNew()}
                    onNewRoom={openNewRoom}
                  />
                ) : undefined
              }
              footerContent={
                <SidebarBoundary part="accounts" message="Accounts couldn’t be shown.">
                  {/* Pages together: Routines beside Usage, actions above the list's end. */}
                  <RoutinesRow
                    open={routinesOpen}
                    collapsed={sidebarProps.isSidebarHidden ?? false}
                    onOpen={() => openRoutines()}
                  />
                  <AccountSwitcher
                    collapsed={sidebarProps.isSidebarHidden ?? false}
                    open={usageOpen}
                    onOpen={openUsage}
                  />
                </SidebarBoundary>
              }
              listContent={
                <SidebarBoundary>
                  <AgentsSidebar
                    agents={listed}
                    selectedId={room ? roomKey(room.id) : (selected?.id ?? null)}
                    showHidden={showHidden}
                    onToggleShowHidden={toggleShowHidden}
                    onSelect={setSelectedId}
                    rooms={roomRows}
                    roomActions={roomActions}
                    actions={actions}
                    query={popoverSearch ? '' : query}
                    searchRef={searchRef}
                    onOpenHit={openHit}
                    onOpenAgent={openAgentByName}
                    currentHit={currentHit}
                  />
                </SidebarBoundary>
              }
            />
          )}

          <main className="agents-main">
            {popoverSearch && (
              <AgentsSearchPopover
                search={search}
                open={popoverOpen}
                field={searchRef}
                onOpenHit={openHit}
                onOpenAgent={openAgentByName}
              />
            )}
            <PaneBoundary
              resetKey={
                room
                  ? roomKey(room.id)
                  : teamOpen
                    ? TEAM_ID
                    : usageOpen
                      ? USAGE_ID
                      : routinesOpen
                        ? ROUTINES_ID
                        : (shown?.id ?? null)
              }
            >
              {error && !loaded ? (
                <div className="agents-main__state">{error}</div>
              ) : loaded && noEngineInstalled(engines) ? (
                <NoEngine
                  onSetUp={(engine) => setEngineSetup({ engine, step: 'install' })}
                  onGoProjects={sidebarProps.onGoProjects}
                />
              ) : room ? (
                <RoomChat
                  key={room.id}
                  room={room}
                  agentsById={agentsById}
                  onOpenAgent={openAgent}
                  compact={pageCompact}
                  {...roomActions}
                />
              ) : usageOpen ? (
                <AgentsUsageView compact={pageCompact} onOpenAgent={openAgent} />
              ) : routinesOpen ? (
                <AgentsRoutinesView
                  compact={pageCompact}
                  onOpenAgent={openAgent}
                  ask={routinesAsk}
                  onAsked={clearRoutinesAsk}
                />
              ) : teamOpen ? (
                <AgentsTeamView
                  onOpenAgent={openAgent}
                  onNewAgent={openNew}
                  onOpenMessage={openMessage}
                  onSignIn={signIn}
                  onInstallEngine={installEngine}
                  compact={pageCompact}
                />
              ) : !shown ? (
                <div className="agents-main__state">
                  <Spinner />
                </div>
              ) : (
                <AgentChat
                  key={shown.id}
                  agent={shown}
                  onOpenAgent={setSelectedId}
                  onSetUpEngine={setUpShownEngine}
                  onSignIn={signInShown}
                  onInstallEngine={installShown}
                  onImport={openImport}
                  onSetUpPhone={shown.isMain ? openPhone : undefined}
                  onOpenApps={openShownApps}
                  onMoreIdeas={shown.isMain ? openIdeas : undefined}
                  onEscape={escapeSearch}
                  compact={chatCompact}
                  {...actions}
                  jumpTo={jump?.agentId === shown.id ? jump.messageId : null}
                  onJumped={clearJump}
                  prefill={prefill?.agentId === shown.id ? prefill : null}
                />
              )}
            </PaneBoundary>
            {isCompact && preview}
          </main>
          {!isCompact && preview}
        </div>

        <AgentEditorModal
          key={
            editor.open
              ? `${editor.agent?.id ?? 'new'}-${editor.tab ?? ''}-${editor.template ?? ''}`
              : 'closed'
          }
          isOpen={editor.open}
          agent={editor.agent}
          initialTab={editor.tab}
          initialTemplate={editor.template}
          focusReach={editor.reach}
          takenColors={agents.map((a) => a.color)}
          onClose={() => setEditor({ open: false, agent: null })}
          onSaved={(id) => {
            void refreshAgents();
            openAgent(id);
          }}
          onDelete={setDeleting}
          onOpenApps={() => openApps(editor.agent?.id)}
          onAskChief={
            editor.agent
              ? undefined
              : () => {
                  const chief = agents.find((a) => a.isMain);
                  if (!chief) return;
                  setEditor({ open: false, agent: null });
                  setPrefill({ agentId: chief.id, text: 'Set up an agent that ', n: Date.now() });
                  setSelectedId(chief.id);
                }
          }
          onAskInChat={(text) => {
            // Settings change in chat: the Chief proposes it on a card.
            const chief = agents.find((a) => a.isMain);
            if (!chief) return;
            setEditor({ open: false, agent: null });
            setPrefill({ agentId: chief.id, text, n: Date.now() });
            setSelectedId(chief.id);
          }}
          onSetUpEngine={(engine, step) => setEngineSetup({ engine, step })}
        />
        <ChiefIdeasModal onPick={pickIdea} onReadyMade={() => openNew(ROLE_TEMPLATES[0]?.id)} />
        <ImportAgentsModal
          isOpen={importOpen}
          initialPath={importPath}
          onClose={(imported) => {
            setImportOpen(false);
            // The note that opened it may have gone with the import; land in the chat.
            if (imported) setFocusAsk((n) => n + 1);
          }}
          onOpenAgent={(id) => {
            setImportOpen(false);
            openAgent(id);
          }}
        />
        <AgentOnItsOwnModal agentId={onItsOwnFor} onClose={() => setOnItsOwnFor(null)} />
        {briefingFor && (
          <AgentBriefingModal
            key={briefingFor.id}
            agentId={briefingFor.id}
            agentName={briefingFor.name}
            onClose={() => setBriefingFor(null)}
          />
        )}
        {recipeFor && (
          <AgentRecipeModal
            key={recipeFor}
            agentId={recipeFor}
            onClose={() => setRecipeFor(null)}
          />
        )}
        <AgentAppsModal
          isOpen={appsOpen}
          onClose={() => setAppsOpen(false)}
          agents={agents}
          forAgentId={appsFor}
        />
        <TeamLoginsModal />
        <BrowserSetupModal />
        {roomEditor.open && (
          <RoomEditorModal
            isOpen
            room={roomEditor.room}
            agents={agents}
            onClose={() => setRoomEditor({ open: false, room: null })}
            onSaved={(saved) => {
              setRoomEditor({ open: false, room: null });
              void refreshRooms().then(() => openAgent(roomKey(saved.id)));
            }}
          />
        )}
        {deletingRoom && (
          <ProjectActionConfirmModal
            title={`Delete ${deletingRoom.name}?`}
            body={
              <p>
                The room and its conversation are deleted. Its agents stay, with their memory and
                their own chats.
              </p>
            }
            hint="This can't be undone."
            loading={false}
            confirmLabel="Delete room"
            loadingLabel="Deleting…"
            confirmVariant="danger"
            onCancel={() => setDeletingRoom(null)}
            onConfirm={() => {
              const gone = deletingRoom;
              setDeletingRoom(null);
              void run(async () => {
                await deleteRoom(gone.id);
                if (selectedId === roomKey(gone.id)) setSelectedId(null);
                await refreshRooms();
              });
            }}
          />
        )}
        {engineSetup && <EngineSignInModal {...engineSetup} onClose={() => setEngineSetup(null)} />}
        {stopping && (
          // In the agent's own colour: a confirm about Acme is Acme's.
          <AccentScope color={stopping.color}>
            <ProjectActionConfirmModal
              title={`Stop ${stopping.name}?`}
              body={<p>What it’s doing now ends here, and anything queued for it is dropped.</p>}
              hint="Its conversation is kept."
              loading={false}
              confirmLabel="Stop"
              loadingLabel="Stopping…"
              confirmVariant="danger"
              onCancel={() => setStopping(null)}
              onConfirm={() => void confirmStop()}
            />
          </AccentScope>
        )}
        {deleting && (
          // In the agent's own colour: a confirm about Acme is Acme's.
          <AccentScope color={deleting.color}>
            <ProjectActionConfirmModal
              title={`Delete ${deleting.name}?`}
              body={<p>Its memory and its whole conversation are deleted with it.</p>}
              hint="This can't be undone."
              loading={deleteBusy}
              confirmLabel="Delete"
              loadingLabel="Deleting…"
              confirmVariant="danger"
              onCancel={() => setDeleting(null)}
              onConfirm={() => void confirmDelete()}
            />
          </AccentScope>
        )}
      </div>
    </OpenReachContext.Provider>
  );
}

/**
 * Neither engine is on this Mac: someone set up on Opencode, Cursor or
 * their own agent. Their projects work as before; agents need one of these.
 */
function NoEngine({
  onSetUp,
  onGoProjects,
}: {
  onSetUp: (engine: AgentEngine) => void;
  onGoProjects: () => void;
}) {
  return (
    <div className="agents-main__state">
      <div className="agents-no-engine">
        <h2 className="agents-no-engine__title">Agents run on Claude Code, Codex or OpenCode</h2>
        <p className="agents-no-engine__body">
          Each agent runs on Claude Code, Codex or OpenCode on this Mac, with your own account or
          models. Set one up and your Chief of Staff is ready to talk.
        </p>
        <div className="agents-no-engine__actions">
          <Button variant="primary" onClick={() => onSetUp('claude')}>
            Set up Claude Code
          </Button>
          <Button variant="secondary" onClick={() => onSetUp('codex')}>
            Set up Codex
          </Button>
          <Button variant="secondary" onClick={() => onSetUp('opencode')}>
            Set up OpenCode
          </Button>
        </div>
        <TextButton onClick={onGoProjects}>Open projects</TextButton>
      </div>
    </div>
  );
}
