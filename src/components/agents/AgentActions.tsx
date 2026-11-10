/**
 * What you can do to an agent, actions only: Edit, What it does on its own, Schedule, Files;
 * Pin, Mark as unread, Mute, Hide; Take over, Start fresh; then Delete, last. One
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
  FileTextIcon,
  RoutineIcon,
  PaperclipIcon,
  PinIcon,
  UploadIcon,
  PlusIcon,
  ShieldCheckIcon,
  TerminalIcon,
  TrashIcon,
} from '@/components/icons';
import { ContextMenuItem, ContextMenuSeparator } from '../primitives/ContextMenu';
import { DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { canTakeOver, contextPercent, type Agent } from '../../lib/agents';
import { ON_ITS_OWN_MENU } from '../../lib/agentOnItsOwn';
import { RECIPE_MENU } from '../../lib/agentRecipe';

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
  /** "What can it do on its own?": its level and every standing rule. */
  onOnItsOwn?: (agent: Agent) => void;
  /** Share it as a recipe: its definition, never what it knows. */
  onShareRecipe?: (agent: Agent) => void;
  /** "What it was told": the briefing its newest turn was given, read-only. Desk only. */
  onWhatItWasTold?: (agent: Agent) => void;
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
  onOnItsOwn,
  onShareRecipe,
  onWhatItWasTold,
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
  // Actions only, in three short groups, Delete last on its own: what you do
  // with it, where it sits in the list, then the conversation itself. Its
  // model and effort are settings, not actions: the header's Model menu and
  // Edit agent → Advanced hold them.
  const items: Item[] = [
    { label: 'Edit agent…', icon: <EditIcon size={12} />, run: () => onEdit(agent) },
    ...(onOnItsOwn
      ? [
          {
            label: ON_ITS_OWN_MENU,
            icon: <ShieldCheckIcon size={12} />,
            run: () => onOnItsOwn(agent),
          },
        ]
      : []),
    ...(onSchedule
      ? [{ label: 'Schedule a routine…', icon: <RoutineIcon size={12} />, run: onSchedule }]
      : []),
    ...(onFiles ? [{ label: 'Files', icon: <PaperclipIcon size={12} />, run: onFiles }] : []),
    ...(onWhatItWasTold
      ? [
          {
            label: 'What it was told…',
            icon: <FileTextIcon size={12} />,
            run: () => onWhatItWasTold(agent),
          },
        ]
      : []),
    ...(onShareRecipe && !agent.isMain
      ? [{ label: RECIPE_MENU, icon: <UploadIcon size={12} />, run: () => onShareRecipe(agent) }]
      : []),
    {
      label: agent.pinned ? 'Unpin' : 'Pin',
      icon: <PinIcon size={12} />,
      run: () => onTogglePin(agent),
      divider: true,
    },
    { label: 'Mark as unread', icon: <CommentIcon size={12} />, run: () => onMarkUnread(agent) },
    {
      label: agent.muted ? 'Unmute notifications' : 'Mute notifications',
      icon: agent.muted ? <BellIcon size={12} /> : <BellOffIcon size={12} />,
      run: () => onToggleMuted(agent),
    },
    {
      label: agent.hidden ? 'Show in sidebar' : 'Hide from sidebar',
      icon: agent.hidden ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />,
      run: () => onToggleHidden(agent),
    },
    ...withDivider([
      ...takeoverItems(agent, onTakeOver, onHandBack),
      {
        // How full this one is, only when its engine said. Never waits on a
        // turn: the turn stays in its own conversation.
        label: freshLabel(agent),
        icon: <PlusIcon size={12} />,
        run: () => onStartFresh(agent),
      },
    ]),
  ];
  if (!agent.isMain) {
    items.push({
      label: 'Delete…',
      icon: <TrashIcon size={12} />,
      run: () => onDelete(agent),
      danger: true,
      divider: true,
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

/** A group, set off by a divider above its first item (none when it's empty). */
function withDivider(group: Item[]): Item[] {
  return group.map((item, i) => (i === 0 ? { ...item, divider: true } : item));
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
  return percent === null
    ? 'New conversation'
    : `New conversation (this one ${percent < 1 ? '<1' : percent}% full)`;
}
