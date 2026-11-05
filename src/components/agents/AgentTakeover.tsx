/**
 * Take over: step into an agent's own session in a terminal and drive it by
 * hand, then hand it back (`agents::takeover`).
 *
 * - **Where it opens.** A bound agent's session becomes a tab in its
 *   project's workspace, which opens on it. Any other agent's opens here, in
 *   its chat, as a terminal in place of the conversation.
 * - **While you drive.** The chat says so in one line ("You're driving
 *   Finance in a terminal · Hand back"). The agent starts no turn; what's
 *   sent to it waits.
 * - **Mid-turn.** The session is in use, so you choose: stop it and take
 *   over, or wait.
 *
 * The terminal only attaches: the backend spawned the process, with an MCP
 * URL and the agent's secrets the webview never sees.
 *
 * @module components/agents/AgentTakeover
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { TerminalIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { AttachedTerminal } from '../terminal/AttachedTerminal';
import { ProjectActionConfirmModal } from '../dashboard/ProjectActionConfirmModal';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { openTakenOverSession } from '../../hooks/useRemoteAgentControl';
import {
  canTakeOver,
  handBackAgent,
  takeOverAgent,
  takeoverWhere,
  type Agent,
  type AgentTakeover,
} from '../../lib/agents';
import { getAgentsSnapshot, refreshAgents, useAgentsSelector } from '../../lib/agentsStore';
import { useAgentProjects } from './AgentProject';

/** The PTY's size until the terminal that shows it fits it. */
const START_COLS = 100;
const START_ROWS = 30;

interface TakeoverActions {
  /** Take over (asking first when it's working), or show the one in progress. */
  takeOver: (agent: Agent) => void;
  handBack: (agent: Agent) => void;
}

const TakeoverContext = createContext<TakeoverActions | null>(null);

/** Null outside Agents mode: nothing there can take over. */
export const useTakeover = () => useContext(TakeoverContext);

/** Show a bound agent's session in its workspace. */
function showInWorkspace(view: AgentTakeover): boolean {
  if (!view.project) return true;
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

  const fail = useCallback(
    (err: unknown) => showToast(formatCommandError(asCommandError(err)), 'error'),
    [showToast]
  );

  const begin = useCallback(
    async (agent: Agent, stopFirst: boolean) => {
      const view = await takeOverAgent(agent.id, START_COLS, START_ROWS, stopFirst);
      await refreshAgents();
      if (!showInWorkspace(view)) {
        showToast(`${agent.name}’s session is open. Open its project to see it.`, 'info');
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

  const handBack = useCallback(
    (agent: Agent) => {
      handBackAgent(agent.id)
        .then(() => refreshAgents())
        .catch(fail);
    },
    [fail]
  );

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

  const value = useMemo(() => ({ takeOver, handBack }), [takeOver, handBack]);
  return (
    <TakeoverContext.Provider value={value}>
      {children}
      {asking && (
        <ProjectActionConfirmModal
          title={`${asking.name} is working`}
          body={
            <p>
              Its session is in use, so you can’t step into it while it works. Stop it and take over
              now, or wait until it’s done.
            </p>
          }
          hint="Stopping keeps what it already did, and drops what’s queued for it."
          loading={busy}
          confirmLabel="Stop and take over"
          loadingLabel="Stopping…"
          confirmVariant="danger"
          cancelLabel="Wait"
          onCancel={() => setAsking(null)}
          onConfirm={() => void confirmStop()}
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
      title={`Step into ${agent.name}’s session in a terminal and carry on by hand`}
      onClick={() => actions.takeOver(agent)}
    >
      Take over
    </TextButton>
  );
}

/**
 * The one line that says you're driving, above the conversation: where, and
 * Hand back. For a session shown here, also hiding or showing the terminal.
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
  return (
    <div className="agent-takeover" role="status">
      <span className="agent-takeover__icon" aria-hidden>
        <TerminalIcon size={12} />
      </span>
      <span className="agent-takeover__text">
        You’re driving {agent.name} {takeoverWhere(takeover, projectName)}
      </span>
      <span className="agent-takeover__actions">
        {takeover.project ? (
          <TextButton tabIndex={0} onClick={() => actions?.takeOver(agent)}>
            Open
          </TextButton>
        ) : (
          <TextButton tabIndex={0} onClick={onToggleTerminal} aria-pressed={terminalShown}>
            {terminalShown ? 'Show chat' : 'Show terminal'}
          </TextButton>
        )}
        <Button size="compact" variant="secondary" onClick={() => actions?.handBack(agent)}>
          Hand back
        </Button>
      </span>
    </div>
  );
}

/** The session itself, in the chat: for an agent with no project to open. */
export function TakeoverTerminal({ takeover }: { takeover: AgentTakeover }) {
  return (
    <div className="agent-takeover-terminal">
      <AttachedTerminal
        sessionId={takeover.ptySession}
        isActive
        failureLabel="Couldn’t show the session"
        className="agent-takeover-terminal__xterm"
      />
    </div>
  );
}
