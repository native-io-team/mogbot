/** Resolve a named terminal at send time and await its paste acknowledgment. */
import type { TerminalHandle } from '../components/terminal/Terminal';
import type { TerminalTab } from '../hooks/useTerminalManagement';
import type { CommentAgent } from './canvasComments';
import { getAgentById, TERMINAL } from './agent';
import { composerDraft, setComposerDraft } from './composerDraft';

export function commentAgents(
  projectPath: string,
  session: {
    terminalTabs: TerminalTab[];
    terminalRefsMap: { current: Map<string, TerminalHandle | null> };
    setActiveTerminalTab: (id: number) => void;
    activeTerminalTab?: number;
  },
  titles: Map<number, string>,
  setHidden: (hidden: boolean) => void
): CommentAgent[] {
  const { terminalTabs: tabs, terminalRefsMap, setActiveTerminalTab, activeTerminalTab } = session;
  return tabs.map((tab) => ({
    id: tab.id,
    label: `${getAgentById(tab.agentId).displayName} · ${titles.get(tab.id) || `Terminal ${tab.id}`}`,
    isAgent: tab.agentId !== TERMINAL.id,
    isActive: tab.id === activeTerminalTab,
    send: async (prompt: string) => {
      const terminal = terminalRefsMap.current.get(`${projectPath}::${tab.id}`);
      if (!terminal?.pastePrompt)
        throw new Error('This terminal is unavailable. Your comments are still pending.');
      setActiveTerminalTab(tab.id);
      setHidden(false);
      await terminal.pastePrompt(prompt);
    },
  }));
}

/**
 * The agent whose chat the project's Session panel shows (`lib/sessionAgentChat`),
 * as a target: the text lands in that chat's composer, appended to whatever is
 * already typed, never sent. It leads the list and counts as active, because
 * when an agent chat is open it is what the user is working with.
 */
export function chatAgentTarget(
  agentId: string,
  name: string,
  setHidden: (hidden: boolean) => void
): CommentAgent {
  return {
    id: -1,
    label: name,
    isAgent: true,
    isActive: true,
    send: (prompt: string) => {
      const before = composerDraft(agentId).trimEnd();
      setComposerDraft(agentId, before ? `${before}\n\n${prompt}` : prompt);
      setHidden(false);
      return Promise.resolve();
    },
  };
}
