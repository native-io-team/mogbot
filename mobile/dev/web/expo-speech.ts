/**
 * Web QA stand-in for expo-speech (see metro.config.js): a voice that speaks
 * silently and never finishes on its own, so `pnpm qa:web` can show a reply
 * being read aloud (the bar over the composer) with no sound and no browser
 * voices, which headless Chrome may not have. Stop ends it as the real one does.
 */

interface Options {
  onStart?: () => void;
  onDone?: () => void;
  onStopped?: () => void;
  onError?: (e: Error) => void;
}

let queue: Options[] = [];

export function speak(_text: string, options: Options = {}) {
  queue.push(options);
  if (queue.length === 1) options.onStart?.();
}

export async function stop() {
  const stopped = queue;
  queue = [];
  stopped.forEach((o) => o.onStopped?.());
}

export async function pause() {}
export async function resume() {}
export async function isSpeakingAsync() {
  return queue.length > 0;
}
export async function getAvailableVoicesAsync() {
  return [];
}
export const maxSpeechInputLength = 4000;
