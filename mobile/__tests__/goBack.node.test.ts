/**
 * Rewind, fork and edit on the phone: the long-press offers, the chat's
 * "Rewound" fold, the project a confirm names, and both methods through the
 * app's real transport to the mock Mac (which keeps `agents/rewind.rs`'s
 * rules: nothing deleted, only your own messages, a fork carries what came
 * before).
 */

import type {
  AgentMessage,
  CompanionEvent,
  Conversations,
  Cursor,
  Rewind,
} from '@shipstudio/companion-protocol';
import { WebSocket } from 'ws';
import { createMockServer } from '../dev/mock-server';
import { messageActions } from '../src/lib/actions';
import { copyProject, foldRewoundItems } from '../src/lib/goBack';
import type { Item } from '../src/lib/timeline';
import { applyEvent, emptySync } from '../src/lib/sync';
import { DirectTransport, WireFailure } from '../src/lib/transport';
import { msg, provenBy, until } from './helpers';

const line = (id: string): Item => ({
  kind: 'message',
  key: id,
  message: msg(id, 1) as AgentMessage,
  grouped: false,
});
const day = (key: string): Item => ({ kind: 'day', key, label: 'Today' });
const rewind = (id: string, ids: string[]): Rewind => ({ id, at: ids[0], ts: 1, ids });
const keys = (items: Item[]) =>
  items.map((i) =>
    i.kind === 'rewound'
      ? `[${i.count}${i.open ? ' open' : ''}]`
      : i.kind === 'rewound-end'
        ? '[end]'
        : `${i.key}${i.past ? ' past' : ''}`
  );

describe('the three ways back on a long-press', () => {
  const ids = (m: Pick<AgentMessage, 'kind' | 'text'>, goBack: boolean) =>
    messageActions(m, false, false, goBack).map((a) => a.id);

  it('are on your own messages, after what was there, when the Mac can go back', () => {
    expect(ids({ kind: 'user', text: 'Fix it' }, true)).toEqual([
      'copy',
      'quote',
      'select',
      'edit',
      'fork',
      'rewind',
    ]);
    expect(messageActions({ kind: 'user', text: 'x' }, false, false, true).slice(-3)).toEqual([
      { id: 'edit', title: 'Edit and resend', icon: 'pencil' },
      { id: 'fork', title: 'Fork from here', icon: 'arrow.triangle.branch' },
      { id: 'rewind', title: 'Rewind to here', icon: 'arrow.uturn.left' },
    ]);
  });

  it('are never on a reply, nor from an older Mac', () => {
    expect(ids({ kind: 'agent', text: 'Done' }, true)).not.toContain('rewind');
    expect(ids({ kind: 'user', text: 'Fix it' }, false)).not.toContain('fork');
  });
});

describe('the Rewound fold', () => {
  // Newest first, as the inverted list draws them.
  const items = [line('m6'), line('m5'), day('d1'), line('m4'), line('m3'), line('m2'), line('m1')];

  it('leaves a chat with no rewinds as it is', () => {
    expect(foldRewoundItems(items, undefined, new Set())).toBe(items);
  });

  it('stands one row in for what a rewind passed over, a day line inside it included', () => {
    const r = rewind('r1', ['m3', 'm4', 'm5']);
    expect(keys(foldRewoundItems(items, [r], new Set()))).toEqual(['m6', '[3]', 'm2', 'm1']);
  });

  it('opens in place as past: its lines muted between the row above and the end line below', () => {
    const r = rewind('r1', ['m3', 'm4', 'm5']);
    expect(keys(foldRewoundItems(items, [r], new Set(['r1'])))).toEqual([
      'm6',
      '[end]',
      'm5 past',
      'd1 past',
      'm4 past',
      'm3 past',
      '[3 open]',
      'm2',
      'm1',
    ]);
  });

  it('keeps two rewinds apart', () => {
    const folded = foldRewoundItems(
      items,
      [rewind('r1', ['m2', 'm3']), rewind('r2', ['m5', 'm6'])],
      new Set()
    );
    expect(keys(folded)).toEqual(['[2]', 'd1', 'm4', '[2]', 'm1']);
  });
});

describe('the project a confirm names', () => {
  it('is the folder of a project an agent works on in a copy, and nothing else', () => {
    expect(copyProject({ project: '/Users/j/ShipStudio/acme-site' })).toBe('acme-site');
    expect(copyProject({ project: '/Users/j/ShipStudio/acme-site', workDirectly: true })).toBeNull();
    expect(copyProject({})).toBeNull();
  });
});

describe('rewind and fork on the mock Mac', () => {
  const mock = createMockServer({ quiet: true, allowAfterMs: 0, draftEveryMs: 10 });
  let t: DirectTransport;
  let state = emptySync();

  beforeAll(async () => {
    const url = await mock.listen();
    t = new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token: mock.issueToken().token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => state.cursor ?? undefined,
      foreground: true,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      ...provenBy(mock),
    });
    t.onEvent((e: CompanionEvent, c?: Cursor) => {
      state = applyEvent(state, e, c);
    });
    await until(() => state.syncedAt != null);
  });

  afterAll(async () => {
    t.close();
    await mock.close();
  });

  const page = async (conversation: string) =>
    (await t.request('agents.messages', { agentId: 'site', limit: 200, conversation })).messages;

  it('serves both', () => {
    expect(t.welcome?.methods).toEqual(
      expect.arrayContaining(['agents.conversationRewind', 'agents.conversationFork'])
    );
  });

  it('forks from what came before, and leaves the original as it was', async () => {
    const before = await page('c-hours');
    const second = before.filter((m) => m.kind === 'user')[0];
    expect(second).toBeDefined();
    const at = before.indexOf(second);
    const list: Conversations = await t.request('agents.conversationFork', {
      agentId: 'site',
      conversationId: 'c-hours',
      messageId: second.id,
    });
    const fork = list.items.find((c) => c.id === list.current)!;
    expect(fork.forkedFrom).toMatchObject({ conversation: 'c-hours', message: second.id });
    expect(fork.title).toBe('Fork of Update the winter opening hours');
    const forked = await page(fork.id);
    expect(forked.slice(0, at).map((m) => m.id)).toEqual(before.slice(0, at).map((m) => m.id));
    expect(forked[forked.length - 1].text).toMatch(/^Forked from “Update the winter opening hours”/);
    expect((await page('c-hours')).map((m) => m.id)).toEqual(before.map((m) => m.id));
  });

  it('rewinds in place: the lines folded, none deleted', async () => {
    const before = await page('c-hours');
    const user = before.find((m) => m.kind === 'user')!;
    const list: Conversations = await t.request('agents.conversationRewind', {
      agentId: 'site',
      conversationId: 'c-hours',
      messageId: user.id,
    });
    const item = list.items.find((c) => c.id === 'c-hours')!;
    expect(item.rewinds?.[0]?.ids[0]).toBe(user.id);
    const after = await page('c-hours');
    expect(after.slice(0, before.length).map((m) => m.id)).toEqual(before.map((m) => m.id));
    expect(after[after.length - 1].text).toMatch(/^Went back to before/);
  });

  it('refuses a reply, and a message already folded', async () => {
    const lines = await page('c-hours');
    const reply = lines.find((m) => m.kind === 'agent')!;
    for (const messageId of [reply.id, lines.find((m) => m.kind === 'user')!.id]) {
      const refused = await t
        .request('agents.conversationRewind', {
          agentId: 'site',
          conversationId: 'c-hours',
          messageId,
        })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(WireFailure);
    }
  });
});
