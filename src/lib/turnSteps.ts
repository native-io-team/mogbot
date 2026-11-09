/**
 * The steps of a finished turn whose page left them out (`stepsOmitted`):
 * read once, when its "What it did" is first opened, and kept for the life
 * of the window. A timeline that came with its steps (a turn that just
 * ended, an older backend, a room) is shown as it came.
 *
 * @module lib/turnSteps
 */

import { useEffect, useState } from 'react';
import { getTurnWork, type TurnWork } from './agents';
import { logger } from './logger';

/** What a turn's steps read came to: the whole timeline, or null (not kept). */
const read = new Map<string, TurnWork | null>();
const reading = new Map<string, Promise<TurnWork | null>>();

/** The same turn's timeline, whatever line carries it now. */
const keyOf = (agentId: string, messageId: string, work: TurnWork) =>
  `${agentId}\u0000${messageId}\u0000${work.startedAt}\u0000${work.stepCount}`;

function readSteps(agentId: string, messageId: string, work: TurnWork) {
  const key = keyOf(agentId, messageId, work);
  let request = reading.get(key);
  if (!request) {
    request = getTurnWork(agentId, messageId).then(
      (full) => {
        read.set(key, full);
        return full;
      },
      (error: unknown) => {
        reading.delete(key);
        throw error;
      }
    );
    reading.set(key, request);
  }
  return request;
}

export type TurnSteps =
  | { state: 'ready'; work: TurnWork }
  | { state: 'reading' }
  /** Pruned since the page was read: the folded line is all there is. */
  | { state: 'gone' }
  | { state: 'failed'; retry: () => void };

/**
 * `work` with its steps, reading them first if its page left them out.
 * Nothing is read until `wanted` (the timeline is open, or has been).
 */
export function useTurnSteps(
  agentId: string,
  messageId: string,
  work: TurnWork,
  wanted: boolean
): TurnSteps {
  const omitted = Boolean(work.stepsOmitted);
  const key = keyOf(agentId, messageId, work);
  const [, setDone] = useState(0);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!omitted || !wanted || read.has(key)) return;
    let live = true;
    readSteps(agentId, messageId, work)
      .then(() => live && setDone((n) => n + 1))
      .catch((error: unknown) => {
        logger.error('[Agents] turn steps failed', { agentId, messageId, error: String(error) });
        if (live) setFailedKey(`${key}#${attempt}`);
      });
    return () => {
      live = false;
    };
  }, [omitted, wanted, key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps -- `work` is named by `key`
  if (!omitted) return { state: 'ready', work };
  const cached = read.get(key);
  if (cached === null) return { state: 'gone' };
  // The folded line as this page has it; the steps (and files) as read.
  if (cached) {
    return {
      state: 'ready',
      work: { ...work, steps: cached.steps, files: cached.files, stepsOmitted: undefined },
    };
  }
  if (failedKey === `${key}#${attempt}`)
    return { state: 'failed', retry: () => setAttempt((n) => n + 1) };
  return { state: 'reading' };
}

/** Tests: forget what was read, as a new window would. */
export function resetTurnStepsForTests() {
  read.clear();
  reading.clear();
}
