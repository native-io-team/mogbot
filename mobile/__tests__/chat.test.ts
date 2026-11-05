import type { Agent, AgentMessage, TeamSetupView } from '@shipstudio/companion-protocol';
import { withQuotes } from '@shipstudio/companion-protocol';
import { SETUP_KEY, withSetupCard, type Item } from '../src/lib/timeline';
import { setupAnchor, setupBar } from '../src/lib/teamSetup';
import { BAR_ORDER } from '../src/lib/bars';
import { agentActions, messageActions, plainText, toggleFor } from '../src/lib/actions';
import { CACHED_MESSAGES, fromCache, toCache, toOutbox } from '../src/lib/cache';
import { EMPTY_DRAFT, liveMentions, putDraft } from '../src/lib/drafts';
import { OUTBOX_WAIT_MS, outboxPlan, restorePending, unreached } from '../src/lib/outbox';
import { emptySync, type PendingSend } from '../src/lib/sync';
import { chatItems, dayLabel, timeLabel } from '../src/lib/timeline';
import { WireFailure } from '../src/lib/transport';
import { looksLikePath, splitStable } from '../src/components/Markdown';
import { mentionQuery, sendMode } from '../src/lib/composer';
import { subtitle } from '../src/lib/agents';
import { drivenBar, drivenLine, drivenWait } from '../src/lib/bars';
import { agent, msg } from './helpers';

const pend = (clientId: string, ts: number, extra: Partial<PendingSend> = {}): PendingSend => ({
  clientId,
  agentId: 'a',
  text: clientId,
  ts,
  failed: false,
  ...extra,
});

describe('drafts', () => {
  it('keeps each chat’s draft and drops one emptied, rather than storing a blank', () => {
    let d = putDraft({}, 'a', { text: 'half a thought' });
    d = putDraft(d, 'b', { quotes: ['the error rate'] });
    expect(d.a.text).toBe('half a thought');
    expect(d.b).toEqual({ ...EMPTY_DRAFT, quotes: ['the error rate'] });
    d = putDraft(d, 'a', { text: '' });
    expect('a' in d).toBe(false);
    // Clearing a chat with nothing in it changes nothing (no re-render, no write).
    expect(putDraft(d, 'zzz', EMPTY_DRAFT)).toBe(d);
  });

  it('forgets a mention whose @Name was deleted from the text', () => {
    const ops = { id: 'a2', name: 'Ops' };
    expect(liveMentions('ask @Ops about it', [ops])).toEqual([ops]);
    expect(liveMentions('ask about it', [ops])).toEqual([]);
  });

  it('sends quotes as blockquotes ahead of the words', () => {
    expect(withQuotes(['line one\nline two'], 'Why?')).toBe('> line one\n> line two\n\nWhy?');
  });
});

describe('outbox', () => {
  const now = 1_000_000_000;
  it('flushes recent waiting sends oldest first, and expires stale ones', () => {
    const plan = outboxPlan(
      {
        a: [pend('late', now - 1000, { waiting: true }), pend('sent', now)],
        b: [
          pend('early', now - 5000, { waiting: true }),
          pend('stale', now - OUTBOX_WAIT_MS - 1, { waiting: true }),
          pend('refused', now, { failed: true }),
        ],
      },
      now
    );
    expect(plan.flush.map((p) => p.clientId)).toEqual(['early', 'late']);
    expect(plan.expire.map((p) => p.clientId)).toEqual(['stale']);
  });

  it('retries only what may not have reached the Mac', () => {
    expect(unreached(new WireFailure({ type: 'Timeout', cmd: 'agents.send', secs: 30 }))).toBe(
      true
    );
    expect(
      unreached(new WireFailure({ type: 'Protocol', code: 'not_connected', message: '' }))
    ).toBe(true);
    expect(unreached(new WireFailure({ type: 'Protocol', code: 'refused', message: 'No !' }))).toBe(
      false
    );
    expect(unreached(new Error('boom'))).toBe(false);
  });

  it('treats a send in flight when the app died as waiting (its clientId makes it safe)', () => {
    const restored = restorePending({
      a: [pend('inflight', 1), pend('failed', 2, { failed: true })],
    });
    expect(restored.a.map((p) => [p.clientId, !!p.waiting, p.failed])).toEqual([
      ['inflight', true, false],
      ['failed', false, true],
    ]);
  });
});

describe('offline cache', () => {
  it('keeps the newest messages of each chat and reopens them as needing a re-read', () => {
    const messages = Array.from({ length: CACHED_MESSAGES + 5 }, (_, i) => msg(`m${i}`, i));
    const s = {
      ...emptySync(),
      cursor: { epoch: 'e', seq: 9 },
      chats: {
        a: { messages, more: false, loaded: true },
        empty: { messages: [], more: true, loaded: true },
      },
      pending: { a: [pend('c1', 1)], b: [] },
    };
    const cached = toCache(s, 123);
    expect(cached.chats.a.messages).toHaveLength(CACHED_MESSAGES);
    expect(cached.chats.a.messages[0].id).toBe('m5');
    expect(cached.chats.a.more).toBe(true);
    expect(cached.chats.empty).toBeUndefined();
    // The outbox is a file of its own (kept where the OS never clears it).
    expect(cached.pending).toBeUndefined();
    expect(Object.keys(toOutbox(s).pending)).toEqual(['a']);
    const back = fromCache(JSON.parse(JSON.stringify(cached)) as typeof cached)!;
    expect(back.cursor).toEqual({ epoch: 'e', seq: 9 });
    expect(back.chats!.a.loaded).toBe(false);
    expect(restorePending(toOutbox(s).pending).a[0].waiting).toBe(true);
    expect(fromCache({ ...cached, v: 99 })).toBeNull();
  });
});

describe('contextual actions', () => {
  const caps = { update: true, markUnread: true };
  const ids = (a: Agent) => agentActions(a, caps).map((x) => x.id);

  it('offers the opposite of each toggle, and Mark as Unread only on a read chat', () => {
    expect(ids(agent({ pinned: false, muted: false, hidden: false, isMain: false }))).toEqual([
      'pin',
      'markUnread',
      'mute',
      'hide',
    ]);
    expect(ids(agent({ pinned: true, muted: true, hidden: true, unread: 3 }))).toEqual([
      'unpin',
      'unmute',
      'unhide',
    ]);
  });

  it('never offers to hide the Chief of Staff, nor what this Mac can’t do', () => {
    expect(ids(agent({ isMain: true }))).not.toContain('hide');
    expect(agentActions(agent(), { update: false, markUnread: false })).toEqual([]);
  });

  it('maps each toggle to the field agents.update takes', () => {
    expect(toggleFor('hide')).toEqual({ hidden: true });
    expect(toggleFor('unmute')).toEqual({ muted: false });
    expect(toggleFor('markUnread')).toBeNull();
  });

  it('offers Copy, Quote and Select Text on words, never on cards', () => {
    expect(messageActions(msg('m', 1, { text: '**Done.** See `a.ts`' })).map((a) => a.id)).toEqual([
      'copy',
      'copyMarkdown',
      'quote',
      'select',
    ]);
    expect(messageActions(msg('m', 1, { kind: 'user', text: 'hi' })).map((a) => a.id)).toEqual([
      'copy',
      'quote',
      'select',
    ]);
    expect(messageActions(msg('m', 1, { kind: 'approval', text: 'Run it?' }))).toEqual([]);
    expect(messageActions(msg('m', 1, { text: '  ' }))).toEqual([]);
  });

  it('offers Remember This only where the Mac serves memory', () => {
    const ids = (remember: boolean) =>
      messageActions(msg('m', 1, { kind: 'user', text: 'hi' }), remember).map((a) => a.id);
    expect(ids(true)).toContain('remember');
    expect(ids(false)).not.toContain('remember');
    expect(messageActions(msg('m', 1, { kind: 'approval', text: 'x' }), true)).toEqual([]);
  });

  it('copies a reply as words, without its markdown', () => {
    expect(
      plainText(
        '## Done\n\n**Production** is on. See [the log](https://x.y) and `npm test`.\n\n- one\n- two'
      )
    ).toBe('Done\n\nProduction is on. See the log and npm test.\n\n• one\n• two');
  });
});

describe('composer', () => {
  it('says what Send will do, and never offers Stop while an approval waits', () => {
    const working = agent({ status: { state: 'working', activity: null, since: 1 } });
    const waiting = agent({ status: { state: 'waiting', activity: null, since: 1 } });
    expect(sendMode(agent(), true)).toBe('send');
    expect(sendMode(agent(), false)).toBe('none');
    expect(sendMode(working, false)).toBe('stop');
    expect(sendMode(working, true)).toBe('queue');
    expect(sendMode(waiting, false)).toBe('none');
    expect(sendMode(waiting, true)).toBe('queue');
  });

  it('finds the @mention being typed at the end, and only there', () => {
    expect(mentionQuery('ask @Op')).toBe('Op');
    expect(mentionQuery('@')).toBe('');
    expect(mentionQuery('mail me@example.com')).toBeNull();
    expect(mentionQuery('ask @Ops now')).toBeNull();
  });
});

describe('timeline', () => {
  const day = 86_400_000;
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  it('tells time with a line per day and per pause, and groups a side’s run', () => {
    const list = [
      msg('y1', now - day, { kind: 'user' }),
      msg('t0', now - 2 * 3_600_000, { kind: 'user' }),
      msg('t1', now - 60_000, { kind: 'user' }),
      msg('t2', now - 50_000, { kind: 'user' }),
      msg('t3', now - 40_000),
      msg('t4', now - 39_000),
    ];
    const items = chatItems(agent(), list, [], undefined, now);
    // `+` marks a message drawn close to the one before it (same side, same run).
    expect(
      items.map((i) => (i.kind === 'message' ? `${i.key}${i.grouped ? '+' : ''}` : i.key))
    ).toEqual(['t4+', 't3', 't2+', 't1', 'day:t1', 't0', 'day:t0', 'y1', 'day:y1']);
    const label = (key: string) => {
      const item = items.find((i) => i.key === key);
      return item?.kind === 'day' ? item.label : null;
    };
    expect(label('day:y1')).toMatch(/^Yesterday \d/);
    expect(label('day:t0')).toMatch(/^Today \d/);
    // A pause the same day: the time alone.
    expect(label('day:t1')).toMatch(/^\d/);
    expect(timeLabel(now - 50_000, now - 60_000, now)).toBeNull();
    expect(dayLabel(now - 60_000, now)).toBe('Today');
    expect(dayLabel(now - day, now)).toBe('Yesterday');
  });

  it('keeps the draft’s key when it becomes its message, so the row never remounts', () => {
    const items = chatItems(agent(), [msg('r1', 1)], [], { id: 'r1', text: 'Deplo' }, 2);
    expect(items.filter((i) => i.key === 'r1')).toHaveLength(1);
    expect(items[0].kind).toBe('draft');
  });
});

describe('Setting up your team, in the timeline', () => {
  // Fictional: an import this afternoon, then a conversation under it.
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  const min = 60_000;
  const keys = (items: Item[]) => items.map((i) => i.key);

  it('stays where it was posted: what you send next is the newest thing, under it', () => {
    const before = [
      msg('review', now - 10 * min),
      msg('imported', now - 9 * min, { kind: 'note' }),
    ];
    const anchor = now - 9 * min;
    let items = withSetupCard(chatItems(agent(), before, [], undefined, now), anchor, false);
    // Newest first (the list is inverted): the card is the newest row for now.
    expect(keys(items)).toEqual([SETUP_KEY, 'imported', 'review', 'day:review']);
    const after = [...before, msg('hi', now - 2 * min, { kind: 'user' }), msg('reply', now - min)];
    items = withSetupCard(
      chatItems(agent(), after, [pend('sending', now)], undefined, now),
      anchor,
      false
    );
    expect(keys(items)).toEqual([
      'pending:sending',
      'reply',
      'hi',
      SETUP_KEY,
      'imported',
      'review',
      'day:review',
    ]);
  });

  it('sits above the time line that opens what came after it', () => {
    const list = [msg('imported', now - 5 * 3_600_000, { kind: 'note' }), msg('later', now - min)];
    const items = withSetupCard(
      chatItems(agent(), list, [], undefined, now),
      now - 5 * 3_600_000,
      false
    );
    expect(keys(items)).toEqual(['later', 'day:later', SETUP_KEY, 'imported', 'day:imported']);
  });

  it('waits for older pages when its place is above what’s loaded', () => {
    const items = chatItems(agent(), [msg('much later', now - min)], [], undefined, now);
    expect(keys(withSetupCard(items, now - 60 * min, true))).not.toContain(SETUP_KEY);
    expect(keys(withSetupCard(items, now - 60 * min, false)).at(-1)).toBe(SETUP_KEY);
  });

  it('uses the Mac’s time, else the end of the import on an older Mac', () => {
    const log = [
      msg('review', now - 10 * min, {
        kind: 'approval',
        approval: { connector: { kind: 'review' } } as AgentMessage['approval'],
      }),
      msg('imported', now - 9 * min, { kind: 'note' }),
      msg('hi', now - min, { kind: 'user' }),
    ];
    expect(setupAnchor({ postedAt: now - 20 * min }, log)).toBe(now - 20 * min);
    expect(setupAnchor({}, log)).toBe(now - 9 * min);
    expect(setupAnchor({}, [msg('hi', now)])).toBeNull();
  });

  it('the bar shows while some is left, and goes once it’s done', () => {
    const v = {
      id: 's',
      source: 'Grok Bot',
      steps: [{ id: 'hello', state: 'open' }],
      done: 1,
      total: 3,
      complete: false,
      agents: 4,
      dismissed: false,
    } as TeamSetupView;
    expect(setupBar(v)).toEqual({
      tone: 'waiting',
      title: 'A few things to finish setting up your team',
      detail: '2 steps left',
    });
    expect(setupBar({ ...v, complete: true })).toBeNull();
    expect(setupBar({ ...v, dismissed: true })).toBeNull();
    expect(BAR_ORDER.indexOf('setup')).toBe(BAR_ORDER.indexOf('import') + 1);
  });
});

describe('streaming markdown', () => {
  it('splits at the last blank line outside a code fence', () => {
    expect(splitStable('one\n\ntwo\n\nthr')).toEqual(['one\n\ntwo\n', '\nthr']);
    const fenced = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;';
    expect(splitStable(fenced)).toEqual(['intro\n', '\n```ts\nconst a = 1;\n\nconst b = 2;']);
    expect(splitStable('no break yet')).toEqual(['', 'no break yet']);
  });

  it('treats file paths as openable and commands as not', () => {
    for (const p of ['src/app/page.tsx', './notes.md', '/Users/me/report.pdf', 'README.md']) {
      expect(looksLikePath(p)).toBe(true);
    }
    for (const p of [
      'npm run build',
      'https://x.y/a.js',
      'useState',
      '1.5',
      'a b.md',
      'console.log',
    ]) {
      expect(looksLikePath(p)).toBe(false);
    }
  });
});

describe('driven on the Mac', () => {
  const driven = () =>
    agent({
      status: { state: 'working', activity: null, since: 5 },
      takeover: { since: 5, cli: 'claude-code' },
    } as Partial<Agent>);

  it('there is no turn to stop: what you send waits, and nothing offers Stop', () => {
    expect(sendMode(driven(), false)).toBe('none');
    expect(sendMode(driven(), true)).toBe('queue');
  });

  it('says it one way everywhere: the row and the bar, in the desk’s words', () => {
    const a = driven();
    expect(drivenLine(a.name)).toBe(`You’re driving ${a.name} on your Mac`);
    expect(subtitle(a)).toBe(drivenLine(a.name));
    expect(drivenBar(a)?.title).toBe(drivenLine(a.name));
    expect(drivenWait(a.name)).toBe(`sends when you hand ${a.name} back`);
  });

  it('a request outranks driving in the row, as on the desk', () => {
    expect(subtitle({ ...driven(), pendingApprovals: 1 })).toBe('Needs your OK');
  });
});
