/**
 * Hook that powers the project rail.
 *
 * Joins three sources of truth into a single render-friendly list:
 *
 * 1. The pinned-projects list from `pins.json` (persisted on disk).
 * 2. The live `SessionRegistry` (frontend, in-memory) for status / unread.
 * 3. The set of all known projects (so the rail can show display names
 *    and thumbnails without each pin needing to fetch them separately).
 *
 * The rail rerenders when:
 * - The user pins / unpins / reorders (we own those mutations).
 * - The session registry notifies us of a status / unread change.
 * - The user opens or closes a project (changes which pin is "current").
 *
 * Rendering is intentionally cheap: we keep the joined list in `useState`
 * and recompute only when one of the sources changes.
 *
 * @module hooks/usePinnedProjects
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listPinnedProjects,
  pinProject as pinProjectApi,
  unpinProject as unpinProjectApi,
  reorderPins as reorderPinsApi,
} from '../lib/pins';
import {
  sessionRegistry,
  type SessionSnapshot,
  type SessionStatus,
  type AgentActivityStatus,
} from '../lib/sessionRegistry';
import { logger } from '../lib/logger';
import { listen } from '@tauri-apps/api/event';
import { AGENT_EVENTS } from '../lib/agents';
import { trackEvent } from '../lib/analytics';
import { getProjectId } from '../lib/projectIdentity';
import { basename } from '../lib/paths';
import { worktreeDisplayName } from '../lib/worktrees';

/** A pinned project as the rail wants to render it. */
export interface PinnedProjectRow {
  /** Absolute project path (the stable identifier). */
  projectPath: string;
  /** Final segment of the path, used as a display name when no project
   *  metadata is loaded. The rail can override with a real name. */
  fallbackName: string;
  /** Live session status. `'inactive'` means pinned but not currently
   *  registered in the session registry (e.g. on app launch before resume). */
  status: SessionStatus | 'inactive';
  /** Live agent activity (idle/thinking/waiting). `'idle'` if no session. */
  agentStatus: AgentActivityStatus;
  /** Unread badge count. Always 0 if no session. */
  unreadCount: number;
  /** Last known memory usage in bytes. 0 if no session. */
  memoryBytes: number;
  /** Whether this pin matches the currently focused project (drives the
   *  "you are here" highlight). */
  isCurrent: boolean;
}

export interface UsePinnedProjectsReturn {
  /** Ordered rows for the rail. */
  rows: PinnedProjectRow[];
  /**
   * Last canonical order returned by the persistence API. This deliberately
   * stays unchanged while a reorder is optimistic so global shortcuts and
   * commands never point at an order the backend has not confirmed yet.
   */
  confirmedPaths: readonly string[];
  /** Set of pinned project paths (for O(1) "is this pinned?" checks). */
  pinnedSet: ReadonlySet<string>;
  /** True while the initial fetch is in flight. */
  isLoading: boolean;
  /** True when at least one pin exists. */
  hasPins: boolean;
  /** Add a project to the rail. Idempotent. */
  pin: (projectPath: string) => Promise<void>;
  /** Remove a project from the rail. Idempotent. */
  unpin: (projectPath: string) => Promise<void>;
  /** Reorder the rail. The new order must contain exactly the existing pins. */
  reorder: (orderedPaths: string[]) => Promise<void>;
  /** Refetch the persisted pin list (e.g. after an external change). */
  refresh: () => Promise<void>;
}

/** Final-segment helper. Used as a display name fallback for the tooltip. */
function lastPathSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Build the rail rows by joining pinned paths with session snapshots.
 * Pure function — given the same inputs, returns equivalent output.
 */
function buildRows(
  pinnedPaths: ReadonlyArray<string>,
  snapshots: ReadonlyArray<SessionSnapshot>,
  currentProjectPath: string | null
): PinnedProjectRow[] {
  const snapshotByPath = new Map(snapshots.map((s) => [s.projectPath, s]));
  return pinnedPaths.map((projectPath) => {
    const snap = snapshotByPath.get(projectPath);
    return {
      projectPath,
      fallbackName: worktreeDisplayName(projectPath) ?? lastPathSegment(projectPath),
      status: snap?.status ?? 'inactive',
      agentStatus: snap?.lastAgentStatus ?? 'idle',
      unreadCount: snap?.unreadCount ?? 0,
      memoryBytes: snap?.memoryBytes ?? 0,
      isCurrent: currentProjectPath === projectPath,
    };
  });
}

/**
 * Powers the project rail. Pass `currentProjectPath` so the rail can
 * highlight the active pin; pass `null` when no project is open.
 */
export function usePinnedProjects(currentProjectPath: string | null): UsePinnedProjectsReturn {
  const [pinnedPaths, setPinnedPaths] = useState<string[]>([]);
  const confirmedPathsRef = useRef<string[]>([]);
  const [confirmedPaths, setConfirmedPaths] = useState<string[]>([]);
  const latestReorderRef = useRef(0);
  const reorderQueueRef = useRef(Promise.resolve());
  const activeReordersRef = useRef(0);
  const refreshDeferredRef = useRef(false);
  const [snapshots, setSnapshots] = useState<SessionSnapshot[]>(() =>
    sessionRegistry.snapshotAll()
  );
  const [isLoading, setIsLoading] = useState(true);

  const confirmPinnedPaths = useCallback((paths: readonly string[]) => {
    const next = [...paths];
    confirmedPathsRef.current = next;
    setConfirmedPaths(next);
  }, []);

  const applyPinnedPaths = useCallback(
    (paths: readonly string[], confirmed: boolean) => {
      const next = [...paths];
      if (confirmed) confirmPinnedPaths(next);
      setPinnedPaths(next);
    },
    [confirmPinnedPaths]
  );

  // Initial fetch + subscribe to backend pin changes. There's no event from
  // the backend today (pins.json mutations come only from this app), so we
  // just refetch on demand via `refresh()`.
  const refresh = useCallback(async () => {
    if (activeReordersRef.current > 0) {
      refreshDeferredRef.current = true;
      return;
    }
    try {
      const list = await listPinnedProjects();
      // A reorder may have started while the backend read was in flight. Do
      // not let that stale response overwrite the optimistic/confirmed order.
      if (activeReordersRef.current > 0) {
        refreshDeferredRef.current = true;
        return;
      }
      applyPinnedPaths(list, true);
    } catch (err) {
      logger.warn('[usePinnedProjects] Failed to list pinned projects', { error: String(err) });
    }
  }, [applyPinnedPaths]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (!cancelled) setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // An agent found a codebase it works in and pinned it (the backend's only
  // pins.json write): read the list again so it shows straight away.
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    try {
      void listen(AGENT_EVENTS.projectFound, () => void refresh())
        .then((u) => (alive ? (off = u) : u()))
        .catch(() => undefined);
    } catch {
      // No Tauri event bridge (tests, the harness): nothing to listen to.
    }
    return () => {
      alive = false;
      off?.();
    };
  }, [refresh]);

  // Subscribe to the session registry so the rail re-renders on
  // status/unread/memory changes.
  useEffect(() => {
    const unsubscribe = sessionRegistry.subscribe((_changedPath, allSnapshots) => {
      setSnapshots([...allSnapshots]);
    });
    return unsubscribe;
  }, []);

  const pin = useCallback(
    async (projectPath: string) => {
      if (activeReordersRef.current > 0) await reorderQueueRef.current;
      try {
        const updated = await pinProjectApi(projectPath);
        applyPinnedPaths(updated, true);
        void trackEvent('project_pinned', {
          project_id: getProjectId(projectPath),
          project_name: basename(projectPath),
          pin_count: updated.length,
        });
      } catch (err) {
        logger.error('[usePinnedProjects] Failed to pin project', {
          projectPath,
          error: String(err),
        });
        throw err;
      }
    },
    [applyPinnedPaths]
  );

  const unpin = useCallback(
    async (projectPath: string) => {
      if (activeReordersRef.current > 0) await reorderQueueRef.current;
      try {
        const updated = await unpinProjectApi(projectPath);
        applyPinnedPaths(updated, true);
        void trackEvent('project_unpinned', {
          project_id: getProjectId(projectPath),
          project_name: basename(projectPath),
          pin_count: updated.length,
        });
      } catch (err) {
        logger.error('[usePinnedProjects] Failed to unpin project', {
          projectPath,
          error: String(err),
        });
        throw err;
      }
    },
    [applyPinnedPaths]
  );

  const reorder = useCallback(
    (orderedPaths: string[]) => {
      const nextOrder = [...orderedPaths];
      const requestId = latestReorderRef.current + 1;
      latestReorderRef.current = requestId;
      // Apply the visible order immediately. Each queued commit captures its
      // confirmed predecessor when it begins, so a later request never rolls
      // back a successful earlier request.
      applyPinnedPaths(nextOrder, false);
      activeReordersRef.current += 1;

      const commit = async () => {
        const confirmedBeforeCommit = [...confirmedPathsRef.current];
        // A preceding queued commit may have changed the canonical order.
        // Re-apply this request's optimistic order immediately before its own
        // backend write unless a newer request already owns the visible order.
        if (requestId === latestReorderRef.current) applyPinnedPaths(nextOrder, false);
        try {
          const updated = await reorderPinsApi(nextOrder);
          // Every successful write advances the confirmed snapshot, but an
          // older queued request must not overwrite the newer optimistic view.
          if (requestId === latestReorderRef.current) applyPinnedPaths(updated, true);
          else confirmPinnedPaths(updated);
        } catch (err) {
          if (requestId === latestReorderRef.current) {
            applyPinnedPaths(confirmedBeforeCommit, true);
          } else {
            confirmPinnedPaths(confirmedBeforeCommit);
          }
          logger.error('[usePinnedProjects] Failed to reorder pins', { error: String(err) });
          throw err;
        } finally {
          activeReordersRef.current -= 1;
          if (activeReordersRef.current === 0 && refreshDeferredRef.current) {
            refreshDeferredRef.current = false;
            void refresh();
          }
        }
      };

      const queued = reorderQueueRef.current.then(commit, commit);
      // Keep the queue alive after a failed commit; the caller still receives
      // the rejection, while a later command can serialize behind it.
      reorderQueueRef.current = queued.then(
        () => undefined,
        () => undefined
      );
      return queued;
    },
    [applyPinnedPaths, confirmPinnedPaths, refresh]
  );

  const rows = useMemo(
    () => buildRows(pinnedPaths, snapshots, currentProjectPath),
    [pinnedPaths, snapshots, currentProjectPath]
  );

  const pinnedSet = useMemo(() => new Set(pinnedPaths), [pinnedPaths]);

  return {
    rows,
    confirmedPaths,
    pinnedSet,
    isLoading,
    hasPins: pinnedPaths.length > 0,
    pin,
    unpin,
    reorder,
    refresh,
  };
}
