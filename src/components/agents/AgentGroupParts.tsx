/**
 * The agent list's sections (`lib/agentGroups.ts`): a folding header per
 * section, dropping a dragged agent into a folder, the one-line field that
 * names a new folder or renames one, and the row and header menu items.
 * Folders live on the Mac; a change that fails there says so in a toast.
 *
 * @module components/agents/AgentGroupParts
 */

import { useState, type PointerEvent, type ReactNode } from 'react';
import { ChevronRightIcon, FolderPlusIcon, PencilIcon, TrashIcon } from '@/components/icons';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../primitives/ContextMenu';
import { TextField } from '../primitives/TextField';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  addGroup,
  moveGroup,
  moveToGroup,
  removeGroup,
  renameGroup,
  setPinnedPlacement,
  startNamingGroup,
  stopNamingGroup,
  toggleCollapsed,
  type AgentSection,
} from '../../lib/agentGroups';
import type { PinnedPlacement } from '../../lib/agents';

/** How far the pointer moves before a press becomes a drag. */
const DRAG_START_PX = 5;

/**
 * Drag a row with the pointer, to reorder it or file it in a folder.
 *
 * Pointer events, not HTML drag and drop: the app's window takes native drags
 * for files dropped on it, so a row's `dragstart` never reached a drop target
 * in the real app (it only worked in a browser). The marks are set on the DOM
 * (`data-drop` on a row, `data-drop-over` on a folder), as the CSS reads them.
 */
export function useAgentPointerDrag({
  agentId,
  enabled,
  group,
  onReorder,
}: {
  agentId: string;
  enabled: boolean;
  /** The folder it's in now (none: undefined). */
  group: string | undefined;
  onReorder: (moved: string, target: string, after: boolean) => void;
}) {
  const change = useMacChange();
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0) return;
    const row = event.currentTarget;
    const list = row.closest('.agents-list');
    const x0 = event.clientX;
    const y0 = event.clientY;
    let started = false;
    let overRow: HTMLElement | null = null;
    let overGroup: HTMLElement | null = null;
    const clear = () => {
      overRow?.removeAttribute('data-drop');
      overGroup?.removeAttribute('data-drop-over');
      overRow = null;
      overGroup = null;
    };
    const move = (e: globalThis.PointerEvent) => {
      if (!started) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < DRAG_START_PX) return;
        started = true;
        row.setAttribute('data-dragging', '');
        // Held, it can't be clicked: it reads as the inactive control it's dimmed as.
        row.setAttribute('aria-disabled', 'true');
        document.body.setAttribute('data-agent-dragging', '');
      }
      e.preventDefault();
      clear();
      const under = document.elementFromPoint(e.clientX, e.clientY);
      if (!under || !list?.contains(under)) return;
      const target = under.closest<HTMLElement>('[data-agent-id][data-movable]');
      if (target && target !== row) {
        const box = target.getBoundingClientRect();
        target.setAttribute('data-drop', e.clientY > box.top + box.height / 2 ? 'after' : 'before');
        overRow = target;
      }
      const folder = under.closest<HTMLElement>('.agents-list__group[data-drop-target]');
      if (folder) {
        folder.setAttribute('data-drop-over', '');
        overGroup = folder;
      }
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      row.removeAttribute('data-dragging');
      row.removeAttribute('aria-disabled');
      document.body.removeAttribute('data-agent-dragging');
      if (!started) return;
      // The release isn't a click on the row.
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      if (overRow?.dataset.agentId) {
        onReorder(agentId, overRow.dataset.agentId, overRow.dataset.drop === 'after');
      }
      if (overGroup) {
        const to = overGroup.dataset.groupId || undefined;
        if (to !== group) change(moveToGroup(agentId, to ?? null));
      }
      clear();
    };
    const cancel = () => {
      started = false;
      clear();
      end();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
  };
  return enabled ? { onPointerDown } : {};
}

/**
 * Drag a folder by its header to put it before or after another folder.
 * Pointer events, as for rows (see above). Only folders take part: the
 * pinned section (the Chief) and "Not in a folder" keep their places. The
 * target folder gets `data-folder-drop` ("before" or "after"), the one
 * moving `data-folder-dragging`; the CSS draws the line from them.
 */
function useFolderPointerDrag(groupId: string | undefined) {
  const change = useMacChange();
  if (!groupId) return {};
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const group = event.currentTarget.closest<HTMLElement>('.agents-list__group');
    const list = group?.closest('.agents-list');
    if (!group || !list) return;
    const x0 = event.clientX;
    const y0 = event.clientY;
    let started = false;
    let over: HTMLElement | null = null;
    const clear = () => {
      over?.removeAttribute('data-folder-drop');
      over = null;
    };
    const move = (e: globalThis.PointerEvent) => {
      if (!started) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < DRAG_START_PX) return;
        started = true;
        group.setAttribute('data-folder-dragging', '');
        document.body.setAttribute('data-agent-dragging', '');
      }
      e.preventDefault();
      clear();
      const under = document.elementFromPoint(e.clientX, e.clientY);
      if (!under || !list.contains(under)) return;
      const target = under.closest<HTMLElement>('.agents-list__group[data-group-id]');
      if (!target || target === group || !target.dataset.groupId) return;
      // Above a folder's header line: before it. Anywhere lower in it: after.
      const head = target.firstElementChild?.getBoundingClientRect();
      const mid = head ? head.top + head.height / 2 : target.getBoundingClientRect().top;
      target.setAttribute('data-folder-drop', e.clientY < mid ? 'before' : 'after');
      over = target;
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      group.removeAttribute('data-folder-dragging');
      document.body.removeAttribute('data-agent-dragging');
      if (!started) return;
      // The release isn't a click on the header (which would fold it).
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      const target = over?.dataset.groupId;
      if (target) change(moveGroup(groupId, target, over?.dataset.folderDrop === 'after'));
      clear();
    };
    const cancel = () => {
      started = false;
      clear();
      end();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
  };
  return { onPointerDown };
}

/** A change sent to the Mac, its failure said in a toast. */
function useMacChange() {
  const { showToast } = useOptionalToast();
  return (change: Promise<unknown>) => {
    change.catch((error) => showToast(formatCommandError(asCommandError(error)), 'error'));
  };
}

/** One section of the list: its header, then its rows unless folded. */
export function AgentGroupSection({
  section,
  collapsed,
  droppable,
  pinned,
  children,
}: {
  section: AgentSection;
  collapsed: boolean;
  /** Folders: an agent dragged here joins it ("Not in a folder": leaves its folder). */
  droppable: boolean;
  /** Where pinned agents sit, for the folder menu's choice. */
  pinned?: PinnedPlacement;
  children: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const change = useMacChange();
  const drag = useFolderPointerDrag(section.groupId);
  const header = renaming ? (
    <FolderNameField
      initial={section.title}
      label={`Rename ${section.title}`}
      onDone={(name) => {
        setRenaming(false);
        if (name && name !== section.title) change(renameGroup(section.groupId!, name));
      }}
    />
  ) : (
    <button
      type="button"
      tabIndex={0}
      className="agents-list__group-toggle"
      aria-expanded={!collapsed}
      onClick={() => toggleCollapsed(section.key)}
      {...drag}
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
      // Read by the row's pointer drag (useAgentPointerDrag).
      data-drop-target={droppable || undefined}
      data-group-id={section.groupId ?? ''}
    >
      {section.groupId && !renaming ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent aria-label={`Actions for ${section.title}`}>
            <ContextMenuItem onSelect={() => setRenaming(true)}>
              <PencilIcon size={12} /> Rename…
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => startNamingGroup()}>
              <FolderPlusIcon size={12} /> New folder…
            </ContextMenuItem>
            <PinnedPlacementItem pinned={pinned} />
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={() => change(removeGroup(section.groupId!))}
            >
              <TrashIcon size={12} /> Remove folder
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        header
      )}
      {!collapsed && children}
      {!collapsed && section.agents.length === 0 && droppable && (
        <p className="agents-list__group-empty">
          <span className="agents-list__group-empty-idle">Drag an agent here</span>
          <span className="agents-list__group-empty-over">Drop to move here</span>
        </p>
      )}
    </div>
  );
}

/** The other place for pinned agents, as one menu item. */
export function PinnedPlacementItem({ pinned }: { pinned: PinnedPlacement | undefined }) {
  const change = useMacChange();
  const inFolder = pinned === 'inFolder';
  return (
    <ContextMenuItem onSelect={() => change(setPinnedPlacement(inFolder ? 'top' : 'inFolder'))}>
      {inFolder ? 'Show pinned agents at the top' : 'Show pinned agents in their folder'}
    </ContextMenuItem>
  );
}

/** One line for a folder's name: Enter keeps it, Escape or leaving it empty puts it away. */
function FolderNameField({
  initial = '',
  label,
  placeholder,
  onDone,
}: {
  initial?: string;
  label: string;
  placeholder?: string;
  /** The trimmed name, or null when put away. */
  onDone: (name: string | null) => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <form
      className="agents-list__group-new"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(name.trim() || null);
      }}
    >
      <TextField
        autoFocus
        value={name}
        placeholder={placeholder}
        aria-label={label}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone(null);
        }}
        onBlur={() => {
          if (!name.trim() || name.trim() === initial) onDone(null);
        }}
      />
    </form>
  );
}

/** "New folder": one line, Enter makes it (filing the agent it was opened for). */
export function NewGroupField() {
  const change = useMacChange();
  return (
    <FolderNameField
      label="New folder name"
      placeholder="Folder name, e.g. SEO"
      onDone={(name) => {
        if (name) change(addGroup(name));
        else stopNamingGroup();
      }}
    />
  );
}

/** A row's folder items (the right-click menu): move, take out, or a new folder for it. */
export function MoveToGroupItems({
  agentId,
  groups,
  current,
}: {
  agentId: string;
  groups: { id: string; name: string }[];
  current: string | undefined;
}) {
  const change = useMacChange();
  return (
    <>
      {groups
        .filter((g) => g.id !== current)
        .map((g) => (
          <ContextMenuItem key={g.id} onSelect={() => change(moveToGroup(agentId, g.id))}>
            Move to {g.name}
          </ContextMenuItem>
        ))}
      {current && (
        <ContextMenuItem onSelect={() => change(moveToGroup(agentId, null))}>
          Remove from folder
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => startNamingGroup(agentId)}>
        <FolderPlusIcon size={12} /> New folder…
      </ContextMenuItem>
    </>
  );
}
