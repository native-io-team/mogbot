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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../primitives/Breadcrumb';
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
  /** A page under this one (an account under Usage): the title becomes "Usage › Work". */
  crumb?: UsageCrumb | null;
  children?: ReactNode;
}

/** Where you are under a page, and the way back to it. */
export interface UsageCrumb {
  name: string;
  back: () => void;
}

export function AgentsPageHeader({
  name,
  icon,
  pageId,
  compact,
  onOpenAgent,
  crumb,
  children,
}: Props) {
  const title = (
    <>
      <AgentKey name={name} colorway="putty" icon={icon} size="md" />
      {crumb ? (
        <h2 className="agent-chat__name agent-chat__crumbs">
          <Breadcrumb aria-label="Where you are">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink onClick={crumb.back} aria-label={`Back to ${name}`}>
                  {name}
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage aria-current="page">{crumb.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </h2>
      ) : (
        <h2 className="agent-chat__name">{name}</h2>
      )}
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
