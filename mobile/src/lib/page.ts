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

export async function refreshPage(agentId: string, conversation: string): Promise<void> {
  if (!pagesOffered()) return;
  try {
    const raw = await call('agents.page', { agentId, conversationId: conversation });
    pages.set(key(agentId, conversation), readPage(raw));
    notify();
  } catch {
    // Kept as it was: the next turn's end reads it again.
  }
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
    if (conversation) void refreshPage(agentId, conversation);
  }, [agentId, conversation, turn]);
  return { page, folded: isFold };
}

/** For tests. */
export function resetPages() {
  pages.clear();
  folded.clear();
  notify();
}
