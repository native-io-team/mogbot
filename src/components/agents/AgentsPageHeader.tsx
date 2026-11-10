/**
 * The header of a page in Agents that isn't a chat (What's in flight, Usage,
 * Routines): a putty key and the page's name, as an agent's header has its
 * key and name. Below the compact breakpoint there's no sidebar, so the
 * header carries the mode toggle and the agent switcher, or the page would
 * have no way out.
 *
 * @module components/agents/AgentsPageHeader
 */

import type { ReactNode } from 'react';
import { CompactModeToggle } from '../workspace/ModeToggle';
import { AgentKey } from './AgentKey';
import { AgentSwitcher } from './AgentSwitcher';
import type { Agent } from '../../lib/agents';

/** What a page needs to stand in for the sidebar in a compact window. */
export interface AgentsPageCompact {
  agents: Agent[];
  onGoHome: () => void;
  onGoProjects: () => void;
}

interface Props {
  /** The page's name, also the key's seed. */
  name: string;
  /** The key's legend. */
  icon: string;
  /** The page's id among the agents (`TEAM_ID`, `ROUTINES_ID`), for the switcher's tick. */
  pageId: string;
  compact?: AgentsPageCompact;
  onOpenAgent: (id: string) => void;
  children?: ReactNode;
}

export function AgentsPageHeader({ name, icon, pageId, compact, onOpenAgent, children }: Props) {
  const title = (
    <>
      <AgentKey name={name} colorway="putty" icon={icon} size="md" />
      <h2 className="agent-chat__name">{name}</h2>
    </>
  );
  return (
    <header className="agent-chat__header">
      {compact && (
        <CompactModeToggle
          mode="agents"
          onProjects={compact.onGoProjects}
          className="agent-chat__mode"
        />
      )}
      {compact ? (
        <AgentSwitcher
          agents={compact.agents}
          currentId={pageId}
          title={title}
          label={`${name}. Switch agent`}
          onOpenAgent={onOpenAgent}
          onGoHome={compact.onGoHome}
        />
      ) : (
        <div className="agent-chat__title">{title}</div>
      )}
      {children}
    </header>
  );
}
