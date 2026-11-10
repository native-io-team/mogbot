/**
 * Delivers a queued prompt (lib/promptHandoff) once the project is open.
 *
 * Delivery is a *spawn*, not a paste. The prompt becomes the agent CLI's
 * opening argument in a brand-new tab, which is the only way it cannot be
 * lost: it is in the process's argv before the agent starts, so there is no
 * window where the terminal exists but the CLI is not yet listening, and
 * nothing has to press Return afterwards.
 *
 * Typing into whichever terminal happened to be active failed in three ways at
 * once — the paste landed while the CLI was still booting and was swallowed;
 * when it did survive it sat unsent in the input box; and if the tab was
 * mid-conversation it interrupted it.
 *
 * Opening a project is still several seconds of mounting and seeding, so this
 * waits for the terminal system to be ready for that project before asking for
 * the tab, and gives up rather than leaving a timer running for the session.
 *
 * @module hooks/usePromptHandoff
 */

import { useCallback, useEffect } from 'react';
import { consumeHandoff, peekHandoff } from '../lib/promptHandoff';
import { logger } from '../lib/logger';
import type { ToastAction, ToastOptions, ToastType } from './useToasts';

const RETRY_MS = 400;
const GIVE_UP_MS = 60_000;

/**
 * What the user is told once the agent is running with the prompt.
 *
 * Deliberately says the agent has *started*, not finished.
 */
export const HANDOFF_DELIVERED_MESSAGE = 'Your agent is on it in a new tab';

/** What the user is told when the prompt could not be delivered at all. */
export const HANDOFF_FAILED_MESSAGE =
  'Could not start an agent in this project. Open a new agent tab and try again.';

/**
 * What the user is told when the project has no room for another tab.
 *
 * Worth its own sentence: retrying for a minute would change nothing, and
 * "could not start an agent" would send them looking for a fault that isn't
 * there.
 */
export const HANDOFF_NO_ROOM_MESSAGE =
  'That project already has the maximum number of agent tabs. Close one and try again.';

interface HandoffDelivery {
  /**
   * Open a new agent tab for `projectPath` whose CLI starts with `prompt`.
   * Returns false while the project's terminal system is not ready yet.
   */
  startAgentWithPrompt: (projectPath: string, prompt: string) => boolean;
  onDelivered?: () => void;
  onFailed?: () => void;
  /** Stop immediately instead of retrying — the blocker will not clear itself. */
  failFast?: boolean;
}

/** The subset of the workspace's terminal bundle this needs. */
interface HandoffTerminals {
  /** Empty until the open project's tabs are seeded. */
  terminalTabs: readonly unknown[];
  /** The cap. A prompt cannot be handed over once it is reached. */
  maxTerminalTabs: number;
  addTerminalTab: (
    agentId?: string,
    options?: { initialPrompt?: string; projectPath?: string }
  ) => void;
}

/**
 * The whole delivery, wired.
 *
 * Lives here rather than in App so the rule it encodes stays next to the
 * reason for it: a prompt is handed over by *starting a new agent with it*,
 * never by typing into whatever terminal is in front of the user.
 */
export function usePromptHandoff(
  currentProjectPath: string | null,
  { terminalTabs, maxTerminalTabs, addTerminalTab }: HandoffTerminals,
  showToast: (
    message: string,
    type?: ToastType,
    action?: ToastAction,
    options?: ToastOptions
  ) => void
): void {
  const terminalTabCount = terminalTabs.length;
  const startAgentWithPrompt = useCallback(
    (projectPath: string, prompt: string): boolean => {
      // Not ready until the project is the open one and its tabs are seeded.
      if (currentProjectPath !== projectPath || terminalTabCount === 0) return false;
      // A new tab, so an in-flight conversation is never interrupted.
      addTerminalTab(undefined, { initialPrompt: prompt, projectPath });
      return true;
    },
    [currentProjectPath, terminalTabCount, addTerminalTab]
  );

  // At the cap, `addTerminalTab` no-ops. Without this the prompt would be
  // consumed by a call that did nothing and vanish silently.
  const atCapacity =
    currentProjectPath !== null && terminalTabCount >= maxTerminalTabs && maxTerminalTabs > 0;

  const onDelivered = useCallback(() => {
    showToast(HANDOFF_DELIVERED_MESSAGE, 'success');
  }, [showToast]);
  const onFailed = useCallback(() => {
    // Being out of tabs is the app enforcing its own cap and telling the
    // user how to proceed — a refusal, not a fault, so it shows like an
    // error without being filed as one (issue #920). A handoff that failed
    // for any other reason genuinely did go wrong.
    showToast(atCapacity ? HANDOFF_NO_ROOM_MESSAGE : HANDOFF_FAILED_MESSAGE, 'error', undefined, {
      expected: atCapacity,
    });
  }, [showToast, atCapacity]);

  useHandoffDelivery(currentProjectPath, {
    startAgentWithPrompt,
    onDelivered,
    onFailed,
    failFast: atCapacity,
  });
}

function useHandoffDelivery(
  projectPath: string | null,
  { startAgentWithPrompt, onDelivered, onFailed, failFast = false }: HandoffDelivery
): void {
  useEffect(() => {
    if (!projectPath || peekHandoff(projectPath) === null) return;

    let timer: number | undefined;
    let cancelled = false;
    const deadline = Date.now() + GIVE_UP_MS;

    const attempt = () => {
      if (cancelled) return;
      // Peek, deliver, then consume: consuming first would drop the prompt
      // every time the workspace simply wasn't ready yet.
      const prompt = peekHandoff(projectPath);
      if (prompt === null) return;

      if (failFast) {
        consumeHandoff();
        logger.warn('[Handoff] Cannot start an agent with the prompt right now', { projectPath });
        onFailed?.();
        return;
      }

      if (startAgentWithPrompt(projectPath, prompt)) {
        consumeHandoff();
        onDelivered?.();
        return;
      }
      if (Date.now() > deadline) {
        // Give the prompt back rather than leaving it queued to ambush a
        // terminal minutes from now.
        consumeHandoff();
        logger.warn('[Handoff] Gave up starting an agent with the prompt', { projectPath });
        onFailed?.();
        return;
      }
      timer = window.setTimeout(attempt, RETRY_MS);
    };

    timer = window.setTimeout(attempt, RETRY_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [projectPath, startAgentWithPrompt, onDelivered, onFailed, failFast]);
}
