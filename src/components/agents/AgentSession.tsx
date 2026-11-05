/**
 * What an agent did in a project, as compact lines in its chat: "Started
 * work in acme-marketing", "Sent to acme-marketing", the project's reply as a
 * card, and preview screenshots inline. Recorded by the backend
 * (`agents/sessions.rs`) from what the shared Remote Access tools actually
 * saw; nothing here is inferred. People read projects, not tabs: no tab
 * numbers and no "session" (docs/agents.md, vocabulary).
 *
 * "Open in {project}" opens the project with that tab selected, so the user
 * can carry on the very same conversation.
 *
 * @module components/agents/AgentSession
 */

import { memo } from 'react';
import { GlobeIcon, TerminalIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { folderName, type Agent, type AgentMessage } from '../../lib/agents';
import { openAgentSession } from '../../hooks/useRemoteAgentControl';
import { useAgentProjects } from './AgentProject';
import { MessageAttachments } from './AgentAttachments';
import { AgentCard } from './AgentCard';

interface SessionCardProps {
  message: AgentMessage;
  agent: Agent;
  arrived?: boolean;
}

/** Memoised like every chat row: a draft or status event doesn't re-render it. */
export const SessionCard = memo(function SessionCard({
  message,
  agent,
  arrived,
}: SessionCardProps) {
  const ctx = useAgentProjects();
  const mark = message.session;
  if (!mark) return null;
  const project =
    ctx?.projects?.find((p) => p.path === mark.project)?.name ?? folderName(mark.project);
  const sessionId = mark.sessionId;
  const line = mark.event === 'started' || mark.event === 'sent';
  const open = sessionId ? (
    <TextButton
      tabIndex={0}
      // The line already leads with the terminal icon.
      leftIcon={line ? undefined : <TerminalIcon size={12} />}
      onClick={() => openAgentSession(mark.project, sessionId)}
    >
      Open in {project}
    </TextButton>
  ) : (
    ctx && (
      <TextButton
        tabIndex={0}
        leftIcon={<GlobeIcon size={12} />}
        onClick={() => ctx.openProject(mark.project)}
      >
        Open preview
      </TextButton>
    )
  );

  if (line) {
    return (
      <div
        className="agent-session"
        data-event={mark.event}
        data-arrived={arrived || undefined}
        data-message-ids={message.id}
      >
        <span className="agent-peer__line" title={message.text || undefined}>
          <TerminalIcon size={12} />
          {mark.event === 'started' ? <>Started work in {project}</> : <>Sent to {project}</>}
        </span>
        {open}
      </div>
    );
  }

  // A reply or a screenshot is a result: the same card every result uses.
  return (
    <AgentCard
      className="agent-session-card"
      data={{ event: mark.event, arrived: arrived || undefined, 'message-ids': message.id }}
      icon={mark.event === 'reply' ? <TerminalIcon size={14} /> : <GlobeIcon size={14} />}
      title={mark.event === 'reply' ? project : `${project} · ${message.text}`}
      actions={open}
    >
      {mark.event === 'reply' ? (
        <p className="agent-session-card__reply">{message.text}</p>
      ) : (
        message.attachments && (
          <MessageAttachments agent={agent} attachments={message.attachments} side="agent" />
        )
      )}
    </AgentCard>
  );
});
