/**
 * A conversation's living page (`agents/page.rs`, `page.ts` in the
 * protocol): the invoke wrappers and a small shared cache, so the panel
 * under the chat header and the header's pin button read one copy. The Mac
 * emits `agents://page` whenever a page changes (the agent's update, a
 * routine's, a pin from the phone), and the conversation it names is read
 * again.
 *
 * @module lib/agentPage
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useSyncExternalStore } from 'react';
import {
  readPage,
  type ConversationPage,
  type PageVersion,
} from '../../packages/companion-protocol/src/page';
import { logger } from './logger';

export {
  pageAgo,
  pageBlocks,
  pageByLine,
  pageChangeLine,
  pageTouched,
  pageUpdatedLine,
  type ConversationPage,
  type PageHistoryEntry,
  type PageVersion,
} from '../../packages/companion-protocol/src/page';

export const PAGE_EVENT = 'agents://page';

export const getPage = async (agentId: string, conversation: string) =>
  readPage(await invoke<unknown>('agents_page', { agentId, conversation }));
export const getPageVersion = (agentId: string, conversation: string, version: number) =>
  invoke<PageVersion | null>('agents_page_version', { agentId, conversation, version });
export const pinPage = async (agentId: string, conversation: string, pinned: boolean) =>
  readPage(await invoke<unknown>('agents_page_pin', { agentId, conversation, pinned }));

/* ------------------------------------------------------------ the cache */

const key = (agentId: string, conversation: string) => `${agentId}#${conversation}`;
/** `undefined`: not read yet; `null`: the conversation has no page. */
const pages = new Map<string, ConversationPage | null>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function put(agentId: string, conversation: string, page: ConversationPage | null) {
  const k = key(agentId, conversation);
  // The same answer again (most often "no page") changes nothing on screen:
  // telling every reader would re-render the whole chat for it.
  if (pages.has(k) && JSON.stringify(pages.get(k)) === JSON.stringify(page)) return;
  pages.set(k, page);
  notify();
}

/** Reads on their way, so the chat and its header asking at once is one read. */
const reading = new Map<string, Promise<void>>();

/** Read the page again from the Mac. A failure leaves what was there. */
export function refreshPage(agentId: string, conversation: string): Promise<void> {
  const k = key(agentId, conversation);
  const already = reading.get(k);
  if (already) return already;
  const read = (async () => {
    try {
      put(agentId, conversation, await getPage(agentId, conversation));
    } catch (e) {
      logger.warn('[AgentPage] Could not read the page', {
        agentId,
        conversation,
        error: String(e),
      });
    }
  })().finally(() => reading.delete(k));
  reading.set(k, read);
  return read;
}

/** Pin or unpin, then show what the Mac kept. */
export async function setPagePinned(
  agentId: string,
  conversation: string,
  pinned: boolean
): Promise<void> {
  put(agentId, conversation, await pinPage(agentId, conversation, pinned));
}

let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  listen<{ agentId?: string; conversation?: string }>(PAGE_EVENT, (e) => {
    const { agentId, conversation } = e.payload ?? {};
    // A read already on its way may have left before this change: read after it.
    if (agentId && conversation) {
      const before = reading.get(key(agentId, conversation)) ?? Promise.resolve();
      void before.then(() => refreshPage(agentId, conversation));
    }
  }).catch(() => {
    listening = false;
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The conversation's page: `undefined` while it is first read, `null` with none. */
export function useConversationPage(
  agentId: string,
  conversation: string | null | undefined
): ConversationPage | null | undefined {
  const k = conversation ? key(agentId, conversation) : null;
  const page = useSyncExternalStore(subscribe, () => (k ? pages.get(k) : null));
  useEffect(() => {
    listenOnce();
    if (conversation && !pages.has(key(agentId, conversation))) {
      void refreshPage(agentId, conversation);
    }
  }, [agentId, conversation]);
  return page;
}

/** For tests: forget every page read. */
export function resetPageCache() {
  pages.clear();
  reading.clear();
  notify();
}
