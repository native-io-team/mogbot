/**
 * The chat store under the event orders a real session produces: duplicates,
 * events overtaking each other, lines arriving while a page is read, a late
 * draft after its reply, old cards updated while only the newest page is held.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import {
  __resetAgentsStore,
  getAgentsSnapshot,
  loadMessages,
  loadOlderMessages,
  MESSAGE_PAGE,
  mergeNewest,
  placeLine,
  updateDraft,
  upsertMessage,
} from './agentsStore';
import type { AgentMessage, Approval } from './agents';

const line = (
  id: string,
  ts: number,
  text = id,
  extra: Partial<AgentMessage> = {}
): AgentMessage => ({
  id,
  agentId: 'a',
  ts,
  kind: 'agent',
  text,
  ...extra,
});
const ids = (key = 'a') => getAgentsSnapshot().messages[key]?.map((m) => m.id);

/** Serve `log`, holding each read until `release()` (to land events mid-read). */
function serve(log: AgentMessage[]) {
  const held: (() => void)[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== 'agents_messages') return null;
    const { limit, before } = args as { limit: number; before?: string };
    const end = before ? log.findIndex((m) => m.id === before) : log.length;
    const pageOf = log.slice(Math.max(0, end - limit), end);
    return new Promise((resolve) => held.push(() => resolve(pageOf)));
  });
  return {
    release: async () => {
      // Let the invoke reach the handler before resolving it.
      await new Promise((r) => setTimeout(r, 0));
      while (held.length) held.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

afterEach(() => __resetAgentsStore());

describe('placeLine', () => {
  it('replaces in place, appends the newest, and puts an overtaken line in its place', () => {
    let list = [line('a', 1), line('b', 3)];
    list = placeLine(list, line('c', 5));
    list = placeLine(list, line('late', 2));
    list = placeLine(list, line('b', 3, 'edited'));
    expect(list.map((m) => m.id)).toEqual(['a', 'late', 'b', 'c']);
    expect(list[2].text).toBe('edited');
  });

  it('keeps the list when the same object comes again', () => {
    const m = line('a', 1);
    const list = [m];
    expect(placeLine(list, m)).toBe(list);
  });
});

describe('events', () => {
  it('a duplicated event is one line', async () => {
    const { release } = serve([line('m1', 1)]);
    const loading = loadMessages('a');
    await release();
    await loading;
    const m = line('m2', 2);
    upsertMessage(m);
    upsertMessage({ ...m });
    upsertMessage({ ...m });
    expect(ids()).toEqual(['m1', 'm2']);
  });

  it('a line written while the first page was read is not lost', async () => {
    const { release } = serve([line('m1', 1)]);
    const loading = loadMessages('a');
    // The event beats the page back (it was written after the read).
    upsertMessage(line('m2', 2));
    await release();
    await loading;
    expect(ids()).toEqual(['m1', 'm2']);
  });

  it('a card answered during the read keeps its answer, not the page copy', async () => {
    const approval = { requestId: 'r', title: 'Run', detail: 'x', status: 'pending' };
    const card = line('c1', 1, '', { kind: 'approval', approval: approval as Approval });
    const { release } = serve([card]);
    const loading = loadMessages('a');
    upsertMessage({ ...card, approval: { ...approval, status: 'allowed' } as Approval });
    await release();
    await loading;
    expect(getAgentsSnapshot().messages.a[0].approval?.status).toBe('allowed');
  });

  it('two opens at once read once', async () => {
    let reads = 0;
    mockIPC((cmd) => {
      if (cmd !== 'agents_messages') return null;
      reads++;
      return [line('m1', 1)];
    });
    await Promise.all([loadMessages('a'), loadMessages('a')]);
    expect(reads).toBe(1);
    expect(ids()).toEqual(['m1']);
  });

  it('a reload keeps the older pages you scrolled to, and lines that arrived', async () => {
    const log = Array.from({ length: MESSAGE_PAGE + 20 }, (_, i) => line(`m${i}`, i));
    const { release } = serve(log);
    let p = loadMessages('a');
    await release();
    await p;
    p = loadOlderMessages('a');
    await release();
    await p;
    expect(ids()[0]).toBe('m0');
    upsertMessage(line('new', 10_000));
    p = loadMessages('a');
    await release();
    await p;
    expect(ids()[0]).toBe('m0');
    expect(ids().slice(-1)[0]).toBe('new');
    expect(new Set(ids()).size).toBe(ids().length);
    expect(getAgentsSnapshot().older.a).toBe(false);
  });

  it('an old card updated while only the newest page is held stays out until its page', async () => {
    const log = Array.from({ length: MESSAGE_PAGE + 5 }, (_, i) => line(`m${i}`, 100 + i));
    const { release } = serve(log);
    const p = loadMessages('a');
    await release();
    await p;
    upsertMessage(line('m1', 101, 'expired'));
    expect(ids()).not.toContain('m1');
    expect(ids().slice(-1)[0]).toBe(`m${MESSAGE_PAGE + 4}`);
  });

  it('a line that overtook an earlier one is shown in time order', async () => {
    const { release } = serve([line('m1', 1)]);
    const p = loadMessages('a');
    await release();
    await p;
    upsertMessage(line('m3', 3));
    upsertMessage(line('m2', 2));
    expect(ids()).toEqual(['m1', 'm2', 'm3']);
  });

  it('a draft event after its reply finished does not bring a second copy back', () => {
    updateDraft('a', 'r1', 'Hel');
    upsertMessage(line('r1', 5, 'Hello.'));
    updateDraft('a', 'r1', 'Hello');
    expect(getAgentsSnapshot().drafts.a).toBeUndefined();
  });

  it('a repeated draft event does not emit', () => {
    updateDraft('a', 'r1', 'Hel');
    const before = getAgentsSnapshot();
    updateDraft('a', 'r1', 'Hel');
    expect(getAgentsSnapshot()).toBe(before);
  });
});

describe('mergeNewest', () => {
  it('no overlap with what was held starts from the page (no gap is papered over)', () => {
    const { messages, keptOlder } = mergeNewest(
      [line('x', 1), line('y', 2)],
      [line('p', 10), line('q', 11)],
      []
    );
    expect(messages.map((m) => m.id)).toEqual(['p', 'q']);
    expect(keptOlder).toBe(false);
  });
});
