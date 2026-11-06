/**
 * Under a project's row in the sidebar: the agents at work in it right now,
 * each as one line ("Juno · Running the build"), the step in the same words
 * its chat's working line uses. Clicking one opens that agent's chat.
 *
 * Only what the Mac reported: an agent shows here while its turn is working
 * in this folder (`TurnWork.project`), and not otherwise.
 *
 * @module components/workspace/ProjectAtWork
 */

import type { AtWorkLine } from './useProjectAgents';
import { TextButton } from '../primitives/TextButton';

export function ProjectAtWork({
  lines,
  onOpenAgent,
}: {
  lines: AtWorkLine[];
  onOpenAgent?: (agentId: string) => void;
}) {
  if (lines.length === 0) return null;
  return (
    <ul className="sidebar-project-at-work" aria-label="Agents at work here">
      {lines.map((line) => (
        <li key={line.agentId} className="sidebar-project-at-work__line">
          <span
            className={`sidebar-row-dot dot-${line.waiting ? 'waiting' : 'active'}`}
            aria-hidden="true"
          />
          <TextButton
            className="sidebar-project-at-work__link"
            onClick={onOpenAgent ? () => onOpenAgent(line.agentId) : undefined}
            disabled={!onOpenAgent}
            title={`${line.name} · ${line.text}`}
            aria-label={`${line.name}, ${line.text}. Open its chat`}
          >
            <span className="sidebar-project-at-work__words">
              <span className="sidebar-project-at-work__name">{line.name}</span>
              <span className="sidebar-project-at-work__text"> · {line.text}</span>
            </span>
          </TextButton>
        </li>
      ))}
    </ul>
  );
}
