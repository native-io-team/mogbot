/**
 * Beside a collapsed project's row: who is working in it, as a small stack of
 * key-cap avatars (three at most, then "+N"). Nothing else: the live step is
 * a row among the project's sessions once it is expanded (`AgentWorkRow`).
 *
 * Only what the Mac reported: an agent shows here while its turn is working
 * in this folder (`TurnWork.project`), and not otherwise.
 *
 * @module components/workspace/ProjectAtWork
 */

import type { AtWorkLine } from './useProjectAgents';
import { AgentKey } from '../agents/AgentKey';

export const AT_WORK_STACK_MAX = 3;

export function ProjectAtWork({ lines }: { lines: AtWorkLine[] }) {
  if (lines.length === 0) return null;
  const shown = lines.slice(0, AT_WORK_STACK_MAX);
  const more = lines.length - shown.length;
  return (
    <span
      className="sidebar-project-at-work"
      role="img"
      aria-label={`At work here: ${lines.map((l) => l.name).join(', ')}`}
    >
      {shown.map((line) => (
        <AgentKey
          key={line.agentId}
          id={line.agentId}
          name={line.name}
          color={line.color}
          state={!line.waiting ? 'working' : 'idle'}
          className="sidebar-project-at-work__avatar"
          size="xs"
        />
      ))}
      {more > 0 && <span className="sidebar-project-at-work__more">+{more}</span>}
    </span>
  );
}
