/**
 * Who works in a project, on its dashboard card and list row: the agents'
 * keys and one line. An agent at work there says what it's doing ("Acme Site
 * · Editing PricingTable.tsx"); agents bound to it and idle say they work
 * here, and whether they have their own copy open.
 *
 * Only what the Mac reported: a binding (`Agent.project`), an open copy
 * (`Agent.copy`) and a turn's folder (`TurnWork.project`). Nothing is said
 * about who made a project, because nothing records that.
 *
 * @module components/dashboard/ProjectTeam
 */

import { AgentKey } from '../agents/AgentKey';
import { TextButton } from '../primitives/TextButton';
import { atWorkLines } from '../workspace/useProjectAgents';
import { sameFolder } from '../../../packages/companion-protocol/src/work';
import type { Agent } from '../../lib/agents';

const STACK_MAX = 3;

export interface ProjectTeamMember {
  agentId: string;
  name: string;
  color: string;
  /** Working there now. */
  working: boolean;
  /** Waiting on your OK there: its key is raised and amber, as everywhere else. */
  waiting?: boolean;
}

export interface ProjectTeamSummary {
  members: ProjectTeamMember[];
  text: string;
}

const names = (list: { name: string }[]) =>
  list.length === 1
    ? list[0].name
    : list.length === 2
      ? `${list[0].name} and ${list[1].name}`
      : `${list[0].name} and ${list.length - 1} more`;

/** The agents in `projectPath` and the line under its name; null when none. */
export function projectTeam(
  agents: Agent[],
  projectPath: string,
  now: number
): ProjectTeamSummary | null {
  const atWork = atWorkLines(agents, projectPath, now);
  const bound = agents.filter(
    (a) =>
      !a.hidden &&
      !!a.project &&
      sameFolder(a.project, projectPath) &&
      !atWork.some((w) => w.agentId === a.id)
  );
  if (atWork.length === 0 && bound.length === 0) return null;
  const members: ProjectTeamMember[] = [
    ...atWork.map((w) => ({
      agentId: w.agentId,
      name: w.name,
      color: w.color,
      working: true,
      waiting: w.waiting,
    })),
    ...bound.map((a) => ({ agentId: a.id, name: a.name, color: a.color, working: false })),
  ];
  let text: string;
  if (atWork.length === 1) {
    text = `${atWork[0].name} · ${atWork[0].text}`;
  } else if (atWork.length > 1) {
    text = `${names(atWork)} at work`;
  } else {
    const copies = bound.filter((a) => a.copy && sameFolder(a.copy.project, projectPath));
    text = `${names(bound)} ${bound.length === 1 ? 'works' : 'work'} here`;
    if (copies.length === bound.length) {
      text += bound.length === 1 ? ' · in its own copy' : ' · each in its own copy';
    }
  }
  return { members, text };
}

interface ProjectTeamProps {
  team: ProjectTeamSummary;
  /** Opens the first agent's chat; absent, the line is only read. */
  onOpenAgent?: (agentId: string) => void;
}

export function ProjectTeam({ team, onOpenAgent }: ProjectTeamProps) {
  const shown = team.members.slice(0, STACK_MAX);
  const more = team.members.length - shown.length;
  const first = team.members[0];
  const keys = (
    <span className="project-card-team-keys" aria-hidden>
      {shown.map((m) => (
        <AgentKey
          key={m.agentId}
          id={m.agentId}
          name={m.name}
          color={m.color}
          state={m.waiting ? 'needsOk' : m.working ? 'working' : 'idle'}
          size="xs"
          className="project-card-team-key"
        />
      ))}
      {more > 0 && <span className="project-card-team-more">+{more}</span>}
    </span>
  );
  const text = <span className="project-card-team-text">{team.text}</span>;
  if (!onOpenAgent) {
    return (
      <span className="project-card-team">
        {keys}
        {text}
      </span>
    );
  }
  return (
    <TextButton
      className="project-card-team project-card-team--link"
      title={`Open ${first.name}’s chat`}
      leftIcon={keys}
      onClick={(e) => {
        // The card opens the project; this opens the agent.
        e.stopPropagation();
        onOpenAgent(first.agentId);
      }}
    >
      {text}
    </TextButton>
  );
}
