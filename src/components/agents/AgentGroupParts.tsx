/**
 * The agent list's optional groups (`lib/agentGroups.ts`): a folding header
 * per section, dropping a dragged agent into one of your own groups, and the
 * one-line field that names a new group.
 *
 * @module components/agents/AgentGroupParts
 */

import { useState, type DragEvent, type ReactNode } from 'react';
import { ChevronRightIcon, TrashIcon } from '@/components/icons';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../primitives/ContextMenu';
import { TextField } from '../primitives/TextField';
import {
  addGroup,
  moveToGroup,
  removeGroup,
  stopNamingGroup,
  toggleCollapsed,
  type AgentSection,
} from '../../lib/agentGroups';

/** The drag's payload type: an agent's id, from its sidebar row. */
export const AGENT_DRAG_TYPE = 'application/x-agent-id';

/** Start dragging a row (your own groups only). */
export function startAgentDrag(event: DragEvent<HTMLElement>, agentId: string) {
  event.dataTransfer.setData(AGENT_DRAG_TYPE, agentId);
  event.dataTransfer.effectAllowed = 'move';
}

/** One section of the list: its header, then its rows unless folded. */
export function AgentGroupSection({
  section,
  collapsed,
  droppable,
  children,
}: {
  section: AgentSection;
  collapsed: boolean;
  /** Your own groups: an agent dragged here joins it (Ungrouped: leaves its group). */
  droppable: boolean;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const accepts = (e: DragEvent) => droppable && e.dataTransfer.types.includes(AGENT_DRAG_TYPE);
  const header = (
    <button
      type="button"
      tabIndex={0}
      className="agents-list__group-toggle"
      aria-expanded={!collapsed}
      onClick={() => toggleCollapsed(section.key)}
    >
      <ChevronRightIcon size={10} className="agents-list__hidden-chevron" />
      <span className="agents-list__group-title">{section.title}</span>
      <span className="agents-list__group-count">{section.agents.length}</span>
    </button>
  );
  return (
    <div
      className="agents-list__group"
      role="group"
      aria-label={section.title}
      data-drop-over={over || undefined}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        if (!accepts(e)) return;
        e.preventDefault();
        const agentId = e.dataTransfer.getData(AGENT_DRAG_TYPE);
        if (agentId) moveToGroup(agentId, section.groupId ?? null);
      }}
    >
      {section.groupId ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent aria-label={`Actions for ${section.title}`}>
            <ContextMenuItem variant="destructive" onSelect={() => removeGroup(section.groupId!)}>
              <TrashIcon size={12} /> Remove group
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        header
      )}
      {!collapsed && children}
      {!collapsed && section.agents.length === 0 && droppable && (
        <p className="agents-list__group-empty">Drag agents here</p>
      )}
    </div>
  );
}

/** "New group": one line, Enter adds it, Escape or leaving puts it away. */
export function NewGroupField() {
  const [name, setName] = useState('');
  return (
    <form
      className="agents-list__group-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (!addGroup(name)) stopNamingGroup();
      }}
    >
      <TextField
        autoFocus
        value={name}
        placeholder="Group name, e.g. a client"
        aria-label="New group name"
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') stopNamingGroup();
        }}
        onBlur={() => {
          if (!name.trim()) stopNamingGroup();
        }}
      />
    </form>
  );
}

/** A row's "Move to" items, for your own groups (the right-click menu). */
export function MoveToGroupItems({
  agentId,
  groups,
  current,
}: {
  agentId: string;
  groups: { id: string; name: string }[];
  current: string | undefined;
}) {
  return (
    <>
      {groups
        .filter((g) => g.id !== current)
        .map((g) => (
          <ContextMenuItem key={g.id} onSelect={() => moveToGroup(agentId, g.id)}>
            Move to {g.name}
          </ContextMenuItem>
        ))}
      {current && (
        <ContextMenuItem onSelect={() => moveToGroup(agentId, null)}>
          Remove from group
        </ContextMenuItem>
      )}
    </>
  );
}
