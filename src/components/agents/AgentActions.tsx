/**
 * What you can do to an agent: Pin, Mark as unread, Mute, Edit, Take over, Start fresh, Hide,
 * Delete. One
 * list, rendered as a row's right-click menu or as the conversation header's
 * … menu, so the two never drift apart.
 *
 * @module components/agents/AgentActions
 */

import type { ReactNode } from 'react';
import {
  BellIcon,
  BellOffIcon,
  CommentIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  HistoryIcon,
  PaperclipIcon,
  PinIcon,
  ResetIcon,
  TerminalIcon,
  TrashIcon,
} from '@/components/icons';
import { ContextMenuItem, ContextMenuSeparator } from '../primitives/ContextMenu';
import { DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { canStartFresh, canTakeOver, contextPercent, type Agent } from '../../lib/agents';

export interface AgentActions {
  onTogglePin: (agent: Agent) => void;
  onToggleHidden: (agent: Agent) => void;
  onToggleMuted: (agent: Agent) => void;
  onMarkUnread: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
  /** A new conversation, memory kept (asks first). */
  onStartFresh: (agent: Agent) => void;
  /** Step into its session in a terminal (asks first while it works). Only in Agents mode. */
  onTakeOver?: (agent: Agent) => void;
  /** End the terminal and give the session back. */
  onHandBack?: (agent: Agent) => void;
}

interface Item {
  label: string;
  icon: ReactNode;
  run: () => void;
  danger?: boolean;
  divider?: boolean;
  disabled?: boolean;
}

export function AgentActionItems({
  agent,
  kind,
  onTogglePin,
  onToggleHidden,
  onToggleMuted,
  onMarkUnread,
  onEdit,
  onDelete,
  onStartFresh,
  onTakeOver,
  onHandBack,
  onSchedule,
  onFiles,
}: {
  agent: Agent;
  kind: 'context' | 'dropdown';
  /** Only where the schedule popover is at hand (the conversation header). */
  onSchedule?: () => void;
  /** Same: only where the Files list can open. */
  onFiles?: () => void;
} & AgentActions) {
  const items: Item[] = [
    {
      label: agent.pinned ? 'Unpin' : 'Pin',
      icon: <PinIcon size={12} />,
      run: () => onTogglePin(agent),
    },
    { label: 'Mark as unread', icon: <CommentIcon size={12} />, run: () => onMarkUnread(agent) },
    {
      label: agent.muted ? 'Unmute notifications' : 'Mute notifications',
      icon: agent.muted ? <BellIcon size={12} /> : <BellOffIcon size={12} />,
      run: () => onToggleMuted(agent),
    },
    ...(onFiles ? [{ label: 'Files', icon: <PaperclipIcon size={12} />, run: onFiles }] : []),
    ...(onSchedule
      ? [{ label: 'Schedule a check-in…', icon: <HistoryIcon size={12} />, run: onSchedule }]
      : []),
    { label: 'Edit agent…', icon: <EditIcon size={12} />, run: () => onEdit(agent) },
    ...takeoverItems(agent, onTakeOver, onHandBack),
    ...(canStartFresh(agent)
      ? [
          {
            // How full it is, only when its engine said.
            label: freshLabel(agent),
            icon: <ResetIcon size={12} />,
            run: () => onStartFresh(agent),
            // Its turn is in the conversation it would leave.
            disabled: agent.status.state !== 'idle',
          },
        ]
      : []),
    {
      label: agent.hidden ? 'Show in sidebar' : 'Hide from sidebar',
      icon: agent.hidden ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />,
      run: () => onToggleHidden(agent),
      divider: true,
    },
  ];
  if (!agent.isMain) {
    items.push({
      label: 'Delete…',
      icon: <TrashIcon size={12} />,
      run: () => onDelete(agent),
      danger: true,
    });
  }

  return (
    <>
      {items.map((item) => [
        item.divider &&
          (kind === 'context' ? (
            <ContextMenuSeparator key={`${item.label}-divider`} />
          ) : (
            <DropdownDivider key={`${item.label}-divider`} />
          )),
        kind === 'context' ? (
          <ContextMenuItem
            key={item.label}
            variant={item.danger ? 'destructive' : 'default'}
            disabled={item.disabled}
            onSelect={item.run}
          >
            {item.icon} {item.label}
          </ContextMenuItem>
        ) : (
          <DropdownItem
            key={item.label}
            icon={item.icon}
            variant={item.danger ? 'danger' : 'default'}
            disabled={item.disabled}
            onSelect={item.run}
          >
            {item.label}
          </DropdownItem>
        ),
      ])}
    </>
  );
}

/** Take over, or Hand back while you're driving; nothing before its first conversation. */
function takeoverItems(
  agent: Agent,
  onTakeOver: ((agent: Agent) => void) | undefined,
  onHandBack: ((agent: Agent) => void) | undefined
): Item[] {
  if (agent.takeover) {
    return onHandBack
      ? [{ label: 'Hand back', icon: <TerminalIcon size={12} />, run: () => onHandBack(agent) }]
      : [];
  }
  if (!onTakeOver || !canTakeOver(agent)) return [];
  return [{ label: 'Take over', icon: <TerminalIcon size={12} />, run: () => onTakeOver(agent) }];
}

function freshLabel(agent: Agent): string {
  const percent = contextPercent(agent);
  return percent === null ? 'Start fresh…' : `Start fresh (${percent < 1 ? '<1' : percent}% full)…`;
}
