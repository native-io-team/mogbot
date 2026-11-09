/**
 * The steps of a finished turn whose page left them out (`stepsOmitted`, a
 * Mac that serves `agents.workSteps`): read once, the first time its "What
 * it did" opens, and kept while the app runs. A timeline that came with its
 * steps (an older Mac, a turn that just ended, a room) shows as it came.
 * The desk's `lib/turnSteps.ts` is the same.
 */

import type { TurnWork } from '@shipstudio/companion-protocol';
import { useEffect, useState } from 'react';
import { call, canCall } from './session';

const read = new Map<string, TurnWork | null>();
const reading = new Map<string, Promise<TurnWork | null>>();

const keyOf = (agentId: string, messageId: string, work: TurnWork) =>
  `${agentId}\u0000${messageId}\u0000${work.startedAt}\u0000${work.stepCount}`;

function readSteps(agentId: string, messageId: string, key: string) {
  let request = reading.get(key);
  if (!request) {
    request = call('agents.workSteps', { agentId, messageId }).then(
      ({ work }) => {
        read.set(key, work ?? null);
        return work ?? null;
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
  /** Pruned on the Mac since the page was read. */
  | { state: 'gone' }
  | { state: 'failed'; retry: () => void };

/** `work` with its steps, read first when `wanted` if its page left them out. */
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
    // Only a Mac that serves it leaves steps out; a page from the offline
    // copy may be read while connected to one that doesn't.
    const request = canCall('agents.workSteps')
      ? readSteps(agentId, messageId, key)
      : Promise.reject(new Error('agents.workSteps not served'));
    request
      .then(() => live && setDone((n) => n + 1))
      .catch(() => live && setFailedKey(`${key}#${attempt}`));
    return () => {
      live = false;
    };
  }, [omitted, wanted, key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps -- named by `key`
  if (!omitted) return { state: 'ready', work };
  const cached = read.get(key);
  if (cached === null) return { state: 'gone' };
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

/** Tests: forget what was read. */
export function resetTurnStepsForTests() {
  read.clear();
  reading.clear();
}
