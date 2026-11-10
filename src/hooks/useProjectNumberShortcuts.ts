import { useEffect, useRef } from 'react';
import type { Project } from '../lib/project';
import { sessionRegistry } from '../lib/sessionRegistry';
import { useModal } from '../contexts/ModalContext';
import { basename } from '../lib/paths';
import { menuNumber, menuOwnsShortcuts, onMenuAction } from '../lib/nativeMenu';
import { familyRootOf, ensureFamilyRoot } from '../lib/worktreeFamilies';
import { getActiveProjectOrder } from '../lib/activeProjectOrder';

interface Params {
  /** Pinned-row paths, in sidebar order. */
  pinnedPaths: readonly string[];
  /** Project-open handler, same as the one the sidebar uses. */
  handleSelectProject: (project: Project) => void | Promise<void>;
  /** Agents is showing: the menu's ⌘1…⌘9 open agents there (hooks/useNativeMenu). */
  inAgents?: boolean;
}

/**
 * The projects ⌘1…⌘9 lead to, in the sidebar's effective order: pinned rows
 * first, then active sessions (deduped against pinned, using the Active
 * group's saved order with a deterministic name fallback — matches
 * `WorkspaceSidebar`). One entry per repository family (a project and its
 * worktrees are one sidebar row); roots come from the shared cache, and
 * resolution starts for any session path not yet resolved so the order
 * converges.
 */
export function projectShortcutOrder(pins: readonly string[]): string[] {
  const pinSet = new Set(pins);
  const snaps = sessionRegistry.snapshotAll();
  for (const s of snaps) ensureFamilyRoot(s.projectPath);
  const seen = new Set<string>();
  const activePaths = snaps
    .map((s) => familyRootOf(s.projectPath))
    .filter((p) => !pinSet.has(p))
    .filter((p) => (seen.has(p) ? false : (seen.add(p), true)))
    .sort((a, b) => {
      const order = getActiveProjectOrder();
      const aRank = order.indexOf(a);
      const bRank = order.indexOf(b);
      if (aRank >= 0 || bRank >= 0) {
        if (aRank < 0) return 1;
        if (bRank < 0) return -1;
        if (aRank !== bRank) return aRank - bRank;
      }
      return (basename(a) || a).localeCompare(basename(b) || b) || a.localeCompare(b);
    });
  return [...pins, ...activePaths];
}

/**
 * Global Cmd/Ctrl+1..9 shortcuts to jump to the Nth project in
 * {@link projectShortcutOrder}.
 *
 * On macOS the Go menu owns ⌘1…⌘9 (so they work from the preview's iframe
 * too) and names the projects; its choice arrives here. Elsewhere it's
 * Ctrl+1..9 as a key handler. The order is read fresh on each press, so pin
 * changes and new sessions are reflected without re-registering.
 */
export function useProjectNumberShortcuts({
  pinnedPaths,
  handleSelectProject,
  inAgents = false,
}: Params): void {
  const palette = useModal('commandPalette');
  const latest = useRef({
    pinnedPaths,
    handleSelectProject,
    closePalette: palette.close,
    inAgents,
  });

  useEffect(() => {
    latest.current = { pinnedPaths, handleSelectProject, closePalette: palette.close, inAgents };
  }, [pinnedPaths, handleSelectProject, palette.close, inAgents]);

  useEffect(() => {
    const switchProject = (index: number): boolean => {
      if (!Number.isInteger(index) || index < 0 || index > 8) return false;

      const { pinnedPaths: pins, handleSelectProject: open, closePalette } = latest.current;
      const path = projectShortcutOrder(pins)[index];
      if (!path) return false;

      closePalette();
      const name = basename(path) || 'Project';
      void open({ name, path, thumbnail: null });
      return true;
    };

    const handler = (e: KeyboardEvent) => {
      // The macOS menu owns this key; handling the keydown too acted twice.
      if (menuOwnsShortcuts()) return;
      if (!e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (e.key.length !== 1 || e.key < '1' || e.key > '9') return;

      const index = parseInt(e.key, 10) - 1;
      if (!switchProject(index)) return;

      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener('keydown', handler, { capture: true });
    const offMenu = onMenuAction((action) => {
      const n = menuNumber(action, 'go_to');
      if (n !== null && !latest.current.inAgents) switchProject(n - 1);
    });

    return () => {
      window.removeEventListener('keydown', handler, { capture: true });
      offMenu();
    };
  }, []);
}
