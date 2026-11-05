/**
 * The offline copy of one Mac's state (docs/mobile.md, "Offline cache and
 * outbox"): the overview, Mac status, projects, the last 400 messages of
 * each chat you've opened and the cursor. Everything cached is readable
 * while the Mac can't be reached; nothing is claimed to be live.
 *
 * The outbox (sends that haven't reached the Mac) is its own file, kept
 * where the OS never clears it (`persist.ts`): the copy can always be
 * fetched again, unsent words can't.
 *
 * The cursor is written in the same file as the state it describes, so a
 * restart resumes from exactly what's on disk: replay can't skip an event
 * the copy doesn't hold.
 */

import type { AgentMessage, Cursor } from '@shipstudio/companion-protocol';
import { restorePending } from './outbox';
import { debounced, readJson, removeJson, writeJson } from './persist';
import { getApp, setApp, useApp, type Served } from './store';
import type { SyncState } from './sync';

export const CACHED_MESSAGES = 400;
const VERSION = 1;

export interface Cached {
  v: number;
  savedAt: number;
  overview: SyncState['overview'];
  mac: SyncState['mac'];
  projects: SyncState['projects'];
  cursor: Cursor | null;
  syncedAt: number | null;
  chats: Record<string, { messages: AgentMessage[]; more: boolean }>;
  /** What the Mac last said it serves: offline cards keep their answers, disabled. */
  served?: Served | null;
  /** Only in copies from before the outbox had its own file. */
  pending?: SyncState['pending'];
}

/** The outbox file. */
export interface Outbox {
  v: number;
  pending: SyncState['pending'];
}

export function toCache(s: SyncState & { served?: Served | null }, now = Date.now()): Cached {
  return {
    v: VERSION,
    savedAt: now,
    served: s.served ?? null,
    overview: s.overview,
    mac: s.mac,
    projects: s.projects,
    cursor: s.cursor,
    syncedAt: s.syncedAt,
    chats: Object.fromEntries(
      Object.entries(s.chats)
        .filter(([, c]) => c.messages.length)
        .map(([id, c]) => [
          id,
          {
            messages: c.messages.slice(-CACHED_MESSAGES),
            more: c.more || c.messages.length > CACHED_MESSAGES,
          },
        ])
    ),
  };
}

export function toOutbox(s: Pick<SyncState, 'pending'>): Outbox {
  return {
    v: VERSION,
    pending: Object.fromEntries(Object.entries(s.pending).filter(([, list]) => list.length)),
  };
}

/** State to start from. Chats are marked unloaded, so each is re-read once connected. */
export function fromCache(c: Cached): (Partial<SyncState> & { served?: Served | null }) | null {
  if (c.v !== VERSION) return null;
  return {
    ...(c.served ? { served: c.served } : {}),
    overview: c.overview,
    mac: c.mac,
    projects: c.projects,
    cursor: c.cursor,
    syncedAt: c.syncedAt,
    chats: Object.fromEntries(
      Object.entries(c.chats).map(([id, chat]) => [id, { ...chat, loaded: false }])
    ),
  };
}

const fileFor = (serverId: string) => `cache-${serverId}.json`;
const outboxFor = (serverId: string) => `outbox-${serverId}.json`;
const saver = debounced(async () => {
  const id = getApp().credentials?.serverId;
  if (id) await writeJson(fileFor(id), toCache(getApp()));
}, 1000);
const outboxSaver = debounced(async () => {
  const id = getApp().credentials?.serverId;
  if (id) await writeJson(outboxFor(id), toOutbox(getApp()));
}, 400);

/**
 * Read the copy and the outbox for this Mac into the store. Returns whether
 * there was a copy. A copy from before the outbox had its own file brings
 * its waiting sends along when there's no outbox file yet.
 */
export async function loadCache(serverId: string): Promise<boolean> {
  const [saved, outbox] = await Promise.all([
    readJson<Cached>(fileFor(serverId)),
    readJson<Outbox>(outboxFor(serverId)),
  ]);
  const state = saved && fromCache(saved);
  const pending = outbox?.v === VERSION ? outbox.pending : saved?.pending;
  if (state || pending) {
    setApp({ ...(state ?? {}), ...(pending ? { pending: restorePending(pending) } : {}) });
  }
  return !!state;
}

/** Keep the copy current: written a second after the synced state settles. */
export function watchCache(): () => void {
  return useApp.subscribe((s, prev) => {
    if (s.pending !== prev.pending) outboxSaver.schedule();
    if (
      s.overview !== prev.overview ||
      s.chats !== prev.chats ||
      s.projects !== prev.projects ||
      s.mac !== prev.mac ||
      s.served !== prev.served ||
      s.cursor !== prev.cursor
    ) {
      saver.schedule();
    }
  });
}

export const flushCache = () => Promise.all([saver.flush(), outboxSaver.flush()]).then(() => {});

export async function forgetCache(serverId: string) {
  saver.cancel();
  outboxSaver.cancel();
  await Promise.all([removeJson(fileFor(serverId)), removeJson(outboxFor(serverId))]);
}
