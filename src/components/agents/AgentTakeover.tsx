/**
 * Take over: step into an agent's own session in a terminal and drive it by
 * hand, then hand it back (`agents::takeover`).
 *
 * - **Where it opens.** A bound agent's session becomes a tab in its
 *   project's workspace, which opens on it. Any other agent's opens here, in
 *   its chat, as a terminal in place of the conversation.
 * - **While you drive.** The chat says so in one bar above the composer
 *   ("You're driving Finance in a terminal · Hand back"), and the sidebar row
 *   says it too; the header stays identity only. The agent starts no turn;
 *   what's sent to it waits, and its copy can't be kept or discarded.
 * - **Mid-turn.** The session is in use, so you choose: stop it and take
 *   over, or wait.
 * - **Handing back** while the terminal is printing asks first: it is likely
 *   mid-response, and anything typed but not sent is dropped.
 *
 * The terminal only attaches: the backend spawned the process, with an MCP
 * URL and the agent's secrets the webview never sees.
 *
 * @module components/agents/AgentTakeover
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { FolderIcon, MoreHorizontalIcon, TerminalIcon } from '@/components/icons';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { AttachedTerminal } from '../terminal/lazyTerminals';
import { ProjectActionConfirmModal } from '../dashboard/ProjectActionConfirmModal';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { openTakenOverSession } from '../../hooks/useRemoteAgentControl';
import {
  canTakeOver,
  handBackAgent,
  takeOverAgent,
  takeoverPolicy,
  takeoverWhere,
  TRUST_HINT,
  type Agent,
  type AgentTakeover,
} from '../../lib/agents';
import { getAgentsSnapshot, refreshAgents, useAgentsSelector } from '../../lib/agentsStore';
import { useAgentProjects } from './AgentProject';
import { ConversationBar } from './AgentCard';

/** The PTY's size until the terminal that shows it fits it. */
const START_COLS = 100;
const START_ROWS = 30;

interface TakeoverActions {
  /** Take over (asking first when it's working), or show the one in progress. */
  takeOver: (agent: Agent) => void;
  /** Hand back (asking first while the terminal is printing). */
  handBack: (agent: Agent) => void;
  /** The agent being handed back right now, while its terminal closes. */
  handingBack: string | null;
}

const TakeoverContext = createContext<TakeoverActions | null>(null);

/** Null outside Agents mode: nothing there can take over. */
export const useTakeover = () => useContext(TakeoverContext);

/** Show a bound agent's session in its workspace. */
function showInWorkspace(view: AgentTakeover | null | undefined): boolean {
  if (!view?.project) return true;
  return openTakenOverSession({
    projectPath: view.project,
    sessionId: view.ptySession,
    agentId: view.cli,
  });
}

export function TakeoverProvider({ children }: { children: ReactNode }) {
  const { showToast } = useOptionalToast();
  const [asking, setAsking] = useState<Agent | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmBack, setConfirmBack] = useState<Agent | null>(null);
  const [handingBack, setHandingBack] = useState<string | null>(null);
  // Take-overs being opened: a second click meanwhile is the same request.
  const opening = useRef(new Set<string>());

  const fail = useCallback(
    (err: unknown) => showToast(formatCommandError(asCommandError(err)), 'error'),
    [showToast]
  );

  const begin = useCallback(
    async (agent: Agent, stopFirst: boolean) => {
      if (opening.current.has(agent.id)) return;
      opening.current.add(agent.id);
      try {
        const view = await takeOverAgent(agent.id, START_COLS, START_ROWS, stopFirst);
        await refreshAgents();
        // The backend answers with the take-over or an error; never read a blank.
        if (view && !showInWorkspace(view)) {
          showToast(`You’re driving ${agent.name}. Open its project to see it.`, 'info');
        }
      } finally {
        opening.current.delete(agent.id);
      }
    },
    [showToast]
  );

  const takeOver = useCallback(
    (given: Agent) => {
      // Rows may hold an older copy; what it's doing now decides.
      const agent = getAgentsSnapshot().agents.find((a) => a.id === given.id) ?? given;
      if (agent.takeover) {
        showInWorkspace(agent.takeover);
        return;
      }
      if (agent.status.state !== 'idle') {
        setAsking(agent);
        return;
      }
      begin(agent, false).catch(fail);
    },
    [begin, fail]
  );

  const finishHandBack = useCallback(
    async (agent: Agent, force: boolean) => {
      setHandingBack(agent.id);
      try {
        const result = await handBackAgent(agent.id, force);
        if (result === 'busy') {
          setConfirmBack(agent);
          return;
        }
        await refreshAgents();
      } catch (err) {
        fail(err);
      } finally {
        setHandingBack((id) => (id === agent.id ? null : id));
      }
    },
    [fail]
  );

  const handBack = useCallback(
    (agent: Agent) => void finishHandBack(agent, false),
    [finishHandBack]
  );

  const confirmHandBack = () => {
    const agent = confirmBack;
    setConfirmBack(null);
    if (agent) void finishHandBack(agent, true);
  };

  const confirmStop = async () => {
    if (!asking) return;
    setBusy(true);
    try {
      await begin(asking, true);
      setAsking(null);
    } catch (err) {
      fail(err);
      setAsking(null);
    } finally {
      setBusy(false);
    }
  };

  const value = useMemo(
    () => ({ takeOver, handBack, handingBack }),
    [takeOver, handBack, handingBack]
  );
  return (
    <TakeoverContext.Provider value={value}>
      {children}
      {asking && (
        <ProjectActionConfirmModal
          title={`${asking.name} is working`}
          body={
            <p>
              It’s in the middle of something, so you can’t step in while it works. Stop it and take
              over now, or wait until it’s done.
            </p>
          }
          hint="Stopping keeps what it already did, and drops what’s queued for it."
          loading={busy}
          confirmLabel="Stop and take over"
          loadingLabel="Stopping…"
          confirmVariant="strong"
          cancelLabel="Wait"
          onCancel={() => setAsking(null)}
          onConfirm={() => void confirmStop()}
        />
      )}
      {confirmBack && (
        <ProjectActionConfirmModal
          title={`Hand ${confirmBack.name} back?`}
          body={
            <p>
              {confirmBack.name} is in the middle of something in the terminal. Handing back now
              stops it there.
            </p>
          }
          hint="Anything typed in the terminal but not sent is dropped."
          loading={false}
          confirmLabel="Hand back anyway"
          loadingLabel="Handing back…"
          confirmVariant="danger"
          cancelLabel="Keep driving"
          onCancel={() => setConfirmBack(null)}
          onConfirm={confirmHandBack}
        />
      )}
    </TakeoverContext.Provider>
  );
}

/** "Take over" as a quiet text action, where a turn's work is shown. */
export function TakeOverButton({ agent: given, className }: { agent: Agent; className?: string }) {
  const actions = useTakeover();
  // Chat rows keep one copy of the agent; this needs its session as it is now.
  const agent = useAgentsSelector((s) => s.agents.find((a) => a.id === given.id)) ?? given;
  if (!actions || !canTakeOver(agent) || agent.takeover) return null;
  return (
    <TextButton
      tabIndex={0}
      className={className}
      title={`Step into ${agent.name}’s conversation in a terminal and carry on by hand`}
      onClick={() => actions.takeOver(agent)}
    >
      Take over
    </TextButton>
  );
}

/**
 * The ways into a working agent, one ⋯ beside its working line: its project,
 * and its session. Rarely wanted, so never a row of their own under every
 * turn. Nothing to offer: no menu.
 */
export function WorkMenu({ agent: given }: { agent: Agent }) {
  const actions = useTakeover();
  const projects = useAgentProjects();
  const agent = useAgentsSelector((s) => s.agents.find((a) => a.id === given.id)) ?? given;
  const project = agent.project && projects ? agent.project : null;
  const projectName = project
    ? (projects?.projects?.find((p) => p.path === project)?.name ?? folderOf(project))
    : null;
  const takeOver = Boolean(actions && canTakeOver(agent) && !agent.takeover);
  if (!project && !takeOver) return null;
  return (
    <Dropdown
      align="left"
      portal
      className="agent-working__more"
      trigger={(p) => (
        <IconButton
          {...p}
          tabIndex={0}
          variant="ghost"
          size="compact"
          icon={<MoreHorizontalIcon size={14} />}
          aria-label={`More for ${agent.name}`}
          title="More"
        />
      )}
    >
      {project && projectName && (
        <DropdownItem
          icon={<FolderIcon size={12} />}
          onSelect={() => projects?.openProject(project)}
        >
          Open in {projectName}
        </DropdownItem>
      )}
      {takeOver && (
        <DropdownItem icon={<TerminalIcon size={12} />} onSelect={() => actions?.takeOver(agent)}>
          Take over
        </DropdownItem>
      )}
    </Dropdown>
  );
}

const folderOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/**
 * The bar that says you're driving, above the composer with the others:
 * where, and Hand back. For a session shown here, also hiding or showing the
 * terminal (which then fills the column above it).
 */
export function TakeoverBanner({
  agent,
  terminalShown,
  onToggleTerminal,
}: {
  agent: Agent;
  terminalShown: boolean;
  onToggleTerminal: () => void;
}) {
  const actions = useTakeover();
  const projects = useAgentProjects();
  const takeover = agent.takeover;
  if (!takeover) return null;
  const projectName = takeover.project
    ? projects?.projects?.find((p) => p.path === takeover.project)?.name
    : undefined;
  const where = takeoverWhere(takeover, projectName);
  const handing = actions?.handingBack === agent.id;
  return (
    <ConversationBar
      state="active"
      icon={<TerminalIcon size={12} />}
      data-testid="agent-takeover"
      title={
        // Said once, here: what driving it means for edits.
        <span className="agent-takeover__text" title={takeoverPolicy(takeover, agent.name)}>
          You’re driving {agent.name} {where}
        </span>
      }
      actions={
        <>
          {takeover.project ? (
            <TextButton tabIndex={0} onClick={() => actions?.takeOver(agent)}>
              Open {where}
            </TextButton>
          ) : (
            <TextButton tabIndex={0} onClick={onToggleTerminal} aria-pressed={terminalShown}>
              {terminalShown ? 'Show chat' : 'Show terminal'}
            </TextButton>
          )}
          <Button
            size="compact"
            variant="secondary"
            disabled={handing}
            aria-busy={handing || undefined}
            onClick={() => actions?.handBack(agent)}
          >
            {handing ? 'Handing back…' : 'Hand back'}
          </Button>
        </>
      }
    >
      {takeover.trustPrompt && <p className="agent-bar__extra">{TRUST_HINT}</p>}
    </ConversationBar>
  );
}

/** The session itself, in the chat: for an agent with no project to open. */
export function TakeoverTerminal({ takeover }: { takeover: AgentTakeover }) {
  return (
    <div className="agent-takeover-terminal">
      <AttachedTerminal
        sessionId={takeover.ptySession}
        isActive
        failureLabel="Couldn’t show the conversation"
        className="agent-takeover-terminal__xterm"
      />
    </div>
  );
}
