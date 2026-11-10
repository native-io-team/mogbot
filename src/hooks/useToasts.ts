/**
 * Custom hook for managing toast notifications.
 *
 * Provides a simple API for showing and dismissing toast notifications
 * with automatic cleanup after a timeout. The window's one stack lives in
 * App's `<ToastProvider>` and is drawn once, by `AppGlobalModals`.
 *
 * @module hooks/useToasts
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { reportError } from '../lib/errorReporting';

/** Toast notification type */
export type ToastType = 'success' | 'error' | 'info';

/** An optional single action rendered inside a toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** Toast notification data */
export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
  /** How many times this same message was shown while it was up (absent or 1: once). */
  count?: number;
}

/**
 * How to show a toast beyond its type and action.
 *
 * `expected` marks an error toast the app *meant* to show: a by-design
 * refusal the user can act on ("that project already has the maximum number
 * of agent tabs"), not something that went wrong. It still looks and behaves
 * like an error — it is a problem from where the user is sitting, and it
 * should persist until they have read it — but it is not filed as a bug.
 *
 * Without this, every such refusal had to be demoted to an `info` toast to
 * stay out of telemetry, which is why the same class of report kept coming
 * back at each new call site (issues #437, #920).
 */
export interface ToastOptions {
  /** A deliberate refusal, not a malfunction — show it, don't report it. */
  expected?: boolean;
}

/** Return type for useToasts hook */
export interface UseToastsReturn {
  /** Array of active toast notifications */
  toasts: Toast[];
  /** Show a new toast notification */
  showToast: (
    message: string,
    type?: ToastType,
    action?: ToastAction,
    options?: ToastOptions
  ) => void;
  /** Dismiss a toast by ID */
  dismissToast: (id: number) => void;
  /** Stop a toast's clock while it is held (pointed at); restart it after. Optional so a test double needn't stub it. */
  holdToast?: (id: number, held: boolean) => void;
}

/** Maximum number of toasts to display at once */
const MAX_TOASTS = 5;
/** Time in ms before a short success/info toast auto-dismisses. Error toasts
 *  never auto-dismiss — the user needs time to read (and copy) the full
 *  detail, so they persist until manually dismissed via the ✕ button. */
const TOAST_DURATION_MS = 4000;
/** The longest a success/info toast stays, however long it is. */
const TOAST_MAX_DURATION_MS = 10000;

/**
 * How long a success/info toast stays: 4 s for a line, longer for a longer
 * one (40 ms a character past 60, up to 10 s), so a two-line toast isn't
 * gone before it has been read.
 */
export function toastDuration(message: string): number {
  const extra = Math.max(0, message.length - 60) * 40;
  return Math.min(TOAST_MAX_DURATION_MS, TOAST_DURATION_MS + extra);
}

/**
 * Hook for managing toast notifications.
 *
 * - The same message shown again while its toast is up (a retry failing the
 *   same way, a button pressed twice) counts on that toast (`count`) instead
 *   of stacking a second copy under it, and its clock starts over.
 * - `holdToast(id, true)` (the pointer is on it) stops its clock;
 *   `holdToast(id, false)` gives it its whole time again.
 *
 * @example
 * ```tsx
 * const { toasts, showToast, dismissToast } = useToasts();
 * showToast('Operation completed', 'success');
 * showToast('Something went wrong', 'error');
 * ```
 */
export function useToasts(): UseToastsReturn {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // The list as of the last change, so showToast can look for a duplicate
  // without being rebuilt (it is a dependency of effects across the app).
  const toastsRef = useRef<Toast[]>([]);
  const toastIdRef = useRef(0);
  const timerMap = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // Clear all toast timers on unmount
  useEffect(() => {
    const map = timerMap.current;
    return () => {
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);

  const commit = useCallback((next: Toast[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const stopClock = useCallback((id: number) => {
    const timer = timerMap.current.get(id);
    if (timer) clearTimeout(timer);
    timerMap.current.delete(id);
  }, []);

  const dismissToast = useCallback(
    (id: number) => {
      stopClock(id);
      if (toastsRef.current.some((t) => t.id === id)) {
        commit(toastsRef.current.filter((t) => t.id !== id));
      }
    },
    [commit, stopClock]
  );

  /** (Re)start a success/info toast's clock; errors have none. */
  const arm = useCallback(
    (toast: Toast) => {
      stopClock(toast.id);
      if (toast.type === 'error') return;
      timerMap.current.set(
        toast.id,
        setTimeout(() => dismissToast(toast.id), toastDuration(toast.message))
      );
    },
    [dismissToast, stopClock]
  );

  const showToast = useCallback(
    (
      message: string,
      type: ToastType = 'success',
      action?: ToastAction,
      options?: ToastOptions
    ) => {
      // An error toast is, by definition, the user seeing something not work as
      // intended — report it to the admin agent (deduped + throttled; see
      // docs/error-reporting.md). Unless the caller says otherwise: a refusal
      // the app decided on is not a malfunction (see `ToastOptions.expected`).
      if (type === 'error' && !options?.expected) {
        reportError({ message, source: 'toast' });
      }
      const current = toastsRef.current;
      const same = current.find(
        (t) => t.message === message && t.type === type && t.action?.label === action?.label
      );
      if (same) {
        const again = { ...same, action, count: (same.count ?? 1) + 1 };
        commit(current.map((t) => (t.id === same.id ? again : t)));
        arm(again);
        return;
      }
      const toast: Toast = { id: ++toastIdRef.current, message, type, action, count: 1 };
      const updated = [...current, toast];
      // Keep max toasts, remove oldest if needed
      updated.slice(0, Math.max(0, updated.length - MAX_TOASTS)).forEach((t) => stopClock(t.id));
      commit(updated.slice(-MAX_TOASTS));
      arm(toast);
    },
    [arm, commit, stopClock]
  );

  const holdToast = useCallback(
    (id: number, held: boolean) => {
      const toast = toastsRef.current.find((t) => t.id === id);
      if (!toast) return;
      if (held) stopClock(id);
      else arm(toast);
    },
    [arm, stopClock]
  );

  return { toasts, showToast, dismissToast, holdToast };
}
