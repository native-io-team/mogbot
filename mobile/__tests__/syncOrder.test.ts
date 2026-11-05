/**
 * The phone's chat copy under the event orders a real link produces:
 * replays after a reconnect, an event overtaken by a page, a draft after
 * its reply, a burst of back-to-back lines.
 */
import type { AgentMessage, AgentsOverview, MacStatus } from '@shipstudio/companion-protocol';
import { applyEvent, emptySync, mergePage, type SyncState } from '../src/lib/sync';
import { msg } from './helpers';

const epoch = 'e1';
const at = (s: SyncState, seq: number, message: AgentMessage) =>
  applyEvent(s, { type: 'agents.message', message }, { epoch, seq });
const ids = (s: SyncState, key = 'a') => s.chats[key]?.messages.map((m) => m.id);

const card = msg('card', 10, {
  kind: 'approval',
  approval: { requestId: 'r', title: 't', detail: '', status: 'pending' },
});
const answered = { ...card, approval: { ...card.approval!, status: 'allowed' as const } };

describe('replays and overtaken events', () => {
  it('a replayed older copy never undoes a newer one', () => {
    let s = applyEvent(emptySync(), { type: 'sync.caughtUp', cursor: { epoch, seq: 0 } });
    s = at(s, 1, card);
    s = at(s, 3, answered);
    // A reconnect resumes from an older cursor and the Mac replays seq 1.
    s = at(s, 1, card);
    expect(s.chats.a.messages[0].approval?.status).toBe('allowed');
    expect(ids(s)).toEqual(['card']);
  });

  it('an event older than a page read after it keeps the page', () => {
    let s = applyEvent(emptySync(), { type: 'sync.caughtUp', cursor: { epoch, seq: 2 } });
    s = mergePage(s, 'a', { messages: [answered], asOf: { epoch, seq: 6 }, more: false }, false);
    s = at(s, 4, card);
    expect(s.chats.a.messages[0].approval?.status).toBe('allowed');
  });

  it('after a new epoch the event applies (seqs from before are not comparable)', () => {
    let s = applyEvent(emptySync(), { type: 'sync.caughtUp', cursor: { epoch, seq: 0 } });
    s = at(s, 9, answered);
    s = applyEvent(s, {
      type: 'sync.snapshot',
      cursor: { epoch: 'e2', seq: 0 },
      overview: { agents: [], engineReady: true, engines: [] } as AgentsOverview,
      status: {} as MacStatus,
      projects: [],
    });
    s = applyEvent(s, { type: 'agents.message', message: card }, { epoch: 'e2', seq: 1 });
    expect(s.chats.a.messages[0].approval?.status).toBe('pending');
  });

  it('a burst of lines arriving out of order is shown in time order, once each', () => {
    let s = emptySync();
    const lines = [msg('m3', 30), msg('m1', 10), msg('m2', 20), msg('m3', 30), msg('m1', 10)];
    lines.forEach((m, i) => (s = at(s, i + 1, m)));
    expect(ids(s)).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('drafts', () => {
  it('a draft event after its finished reply does not show a second copy', () => {
    let s = at(emptySync(), 1, msg('r1', 10, { text: 'Hello.' }));
    s = applyEvent(s, { type: 'agents.draft', agentId: 'a', id: 'r1', from: 0, text: 'Hel' });
    expect(s.drafts.a).toBeUndefined();
  });

  it('a draft for a different reply still streams', () => {
    let s = at(emptySync(), 1, msg('r1', 10));
    s = applyEvent(s, { type: 'agents.draft', agentId: 'a', id: 'r2', from: 0, text: 'Hel' });
    expect(s.drafts.a?.text).toBe('Hel');
  });
});
