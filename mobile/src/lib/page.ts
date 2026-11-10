/**
 * A conversation's living page (`agents/page.rs`, the protocol's `page.ts`)
 * on the phone: read from the Mac (`agents.page`, only where the Mac serves
 * it), kept in a small cache the chat reads, read again when the
 * conversation on screen changes or the agent's turn moves on (the page
 * changes inside turns and routines). Folding is this phone's own, per
 * conversation, for as long as the app runs.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { readPage, type ConversationPage, type PageVersion } from '@shipstudio/companion-protocol';
import { call, canCall } from './session';

const key = (agentId: string, conversation: string) => `${agentId}#${conversation}`;
const pages = new Map<string, ConversationPage | null>();
const folded = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Whether this Mac keeps pages (older ones don't: the phone shows none). */
export const pagesOffered = () => canCall('agents.page');

/** Reads on their way: two asking at once is one read. */
const reading = new Map<string, Promise<void>>();
/** The turn each conversation's page was last read at, and when (`useConversationPage`). */
const readAt = new Map<string, { turn: string; at: number }>();
/** Opening a chat again within this long, with no new turn, reads nothing. */
const REREAD_AFTER_MS = 30_000;

export function refreshPage(agentId: string, conversation: string): Promise<void> {
  if (!pagesOffered()) return Promise.resolve();
  const k = key(agentId, conversation);
  const already = reading.get(k);
  if (already) return already;
  const read = (async () => {
    try {
      const raw = await call('agents.page', { agentId, conversationId: conversation });
      const page = readPage(raw);
      // The same answer again (most often "no page") changes nothing on screen.
      if (pages.has(k) && JSON.stringify(pages.get(k)) === JSON.stringify(page)) return;
      pages.set(k, page);
      notify();
    } catch {
      // Kept as it was: the next turn's end reads it again.
      readAt.delete(k);
    }
  })().finally(() => reading.delete(k));
  reading.set(k, read);
  return read;
}

export async function pinPage(agentId: string, conversation: string, pinned: boolean) {
  const raw = await call('agents.pagePin', { agentId, conversationId: conversation, pinned });
  pages.set(key(agentId, conversation), readPage(raw));
  notify();
}

export const pageVersion = (agentId: string, conversation: string, version: number) =>
  call('agents.pageVersion', {
    agentId,
    conversationId: conversation,
    version,
  }) as Promise<PageVersion | null>;

/** The page last read for a conversation, or null: what a rewind's confirm names. */
export const pageOf = (agentId: string, conversation: string) =>
  pages.get(key(agentId, conversation)) ?? null;

export const isFolded = (agentId: string, conversation: string) =>
  folded.has(key(agentId, conversation));

export function setFolded(agentId: string, conversation: string, fold: boolean) {
  if (fold) folded.add(key(agentId, conversation));
  else folded.delete(key(agentId, conversation));
  notify();
}

/**
 * The page of the conversation on screen, or null. `turn` is anything that
 * changes when the agent's turn moves on (its state, its newest line): the
 * page is read again then.
 */
export function useConversationPage(
  agentId: string,
  conversation: string | undefined,
  turn: string
): { page: ConversationPage | null; folded: boolean } {
  const k = conversation ? key(agentId, conversation) : '';
  const page = useSyncExternalStore(subscribe, () => (k ? (pages.get(k) ?? null) : null));
  const isFold = useSyncExternalStore(subscribe, () => (k ? folded.has(k) : false));
  useEffect(() => {
    if (!conversation) return;
    // Read once per turn position: tapping back into the chat with nothing
    // new since asks the Mac for nothing (a pin changed on the desk shows on
    // the next turn, or on opening it after a while).
    const k = key(agentId, conversation);
    const last = readAt.get(k);
    if (last?.turn === turn && Date.now() - last.at < REREAD_AFTER_MS) return;
    readAt.set(k, { turn, at: Date.now() });
    void refreshPage(agentId, conversation);
  }, [agentId, conversation, turn]);
  return { page, folded: isFold };
}

/** For tests. */
export function resetPages() {
  pages.clear();
  reading.clear();
  readAt.clear();
  folded.clear();
  notify();
}
