/**
 * What the phone says is waiting on you, and on what: only what it can
 * answer is "Needs your OK" (an import review is answered on the Mac); the
 * Agents tab's badge and Home's summary are one number; engines are told
 * apart; a refused send says why and is never offered to Send again; and a
 * double-tap sends once.
 */

import type { Agent, AgentMessage, Approval, EngineInfo } from '@shipstudio/companion-protocol';
import {
  answerableHere,
  attentionCounts,
  failureLine,
  needsLine,
  needsYouHere,
  nextNeedsYou,
  ON_MAC_LINE,
  pendingApproval,
  sessionLabel,
  subtitle,
  waitingOnMac,
} from '../src/lib/agents';
import { takeDraft } from '../src/lib/composer';
import { engineHealth, engineLayers, pill } from '../src/lib/connection';
import { EMPTY_DRAFT, refusedToDraft } from '../src/lib/drafts';
import { emptySync, setPendingFailed, type PendingSend } from '../src/lib/sync';
import { agent } from './helpers';

const card = (id: string, over: Partial<Approval> = {}): AgentMessage => ({
  id,
  agentId: 'chief',
  ts: 1,
  kind: 'approval',
  text: '',
  approval: {
    requestId: `r-${id}`,
    title: 'Run a command',
    detail: 'ls',
    status: 'pending',
    ...over,
  },
});
const review = (id: string) =>
  card(id, {
    title: 'Bring in 2 agents from Grok',
    connector: { kind: 'review', talkId: 't', source: 'Grok', review: { proposals: [] } },
  });
const consent = (id: string) =>
  card(id, {
    title: 'Grok wants to talk',
    connector: { kind: 'consent', talkId: 't', source: 'Grok' },
  });

const chief = (over: Partial<Agent> = {}) =>
  agent({ id: 'chief', name: 'Chief of Staff', hidden: false, pinned: true, ...over });

describe('a card only the Mac can answer', () => {
  it('is an import review; a consent card and an ordinary approval are answered here', () => {
    expect(answerableHere(review('a').approval!)).toBe(false);
    expect(answerableHere(consent('b').approval!)).toBe(true);
    expect(answerableHere(card('c').approval!)).toBe(true);
  });

  it('is never the card the chat pins or jumps to', () => {
    expect(pendingApproval([card('old'), review('new')])?.id).toBe('old');
    expect(pendingApproval([review('only')])).toBeUndefined();
  });

  it('with only a review waiting, the agent waits on the Mac, not on this phone', () => {
    const a = chief({ pendingApprovals: 1 });
    const messages = [review('r')];
    expect(waitingOnMac(a, messages)).toBe(true);
    expect(needsYouHere(a, messages)).toBe(false);
    expect(needsLine(a, messages)).toMatch(new RegExp(`^${ON_MAC_LINE}`));
    expect(attentionCounts([a], { chief: { messages } }).needYou).toBe(0);
    expect(nextNeedsYou([a], { chief: { messages } })).toBeNull();
  });

  it('says needs-you again as soon as there is something answerable, or more than the chat shows', () => {
    // An approval beside the review.
    const both = [review('r'), card('c')];
    expect(waitingOnMac(chief({ pendingApprovals: 2 }), both)).toBe(false);
    expect(nextNeedsYou([chief({ pendingApprovals: 2 })], { chief: { messages: both } })).toEqual({
      agentId: 'chief',
      messageId: 'c',
    });
    // The Mac counts two, the saved chat has one review: the other may be answerable.
    expect(waitingOnMac(chief({ pendingApprovals: 2 }), [review('r')])).toBe(false);
    // Stopped mid-turn on a card: that's answered here.
    expect(
      waitingOnMac(
        chief({ pendingApprovals: 1, status: { state: 'waiting', activity: null, since: 1 } }),
        [review('r')]
      )
    ).toBe(false);
    // No saved chat: nothing is hidden on a guess.
    expect(waitingOnMac(chief({ pendingApprovals: 1 }), undefined)).toBe(false);
  });
});

describe('the Agents badge and Home’s summary', () => {
  it('count the same agents: what needs you here, not failures or the Mac’s reviews', () => {
    const agents = [
      chief({ pendingApprovals: 1 }),
      agent({ id: 'site', name: 'Site', hidden: false, pendingApprovals: 1 }),
      agent({ id: 'fin', name: 'Finance', hidden: false, failure: { kind: 'usage_limit' } }),
      agent({ id: 'gone', name: 'Hidden', hidden: true, pendingApprovals: 1 }),
    ];
    const chats = { chief: { messages: [review('r')] }, site: { messages: [card('c')] } };
    // The tab reads exactly this (app/(tabs)/_layout.tsx), and so does the summary.
    expect(attentionCounts(agents, chats).needYou).toBe(1);
    expect(nextNeedsYou(agents, chats)?.agentId).toBe('site');
  });
});

describe('engines', () => {
  const engines = (codex: Partial<EngineInfo>, claude: Partial<EngineInfo> = {}): EngineInfo[] => [
    {
      id: 'claude',
      label: 'Claude Code',
      installed: false,
      signedIn: false,
      models: [],
      ...claude,
    },
    { id: 'codex', label: 'Codex', installed: true, signedIn: true, models: [], ...codex },
  ];
  const mac = (installed: boolean, signedIn: 'yes' | 'no' | 'unknown' = 'unknown') =>
    ({ claude: { installed, signedIn } }) as never;
  const base = {
    link: { kind: 'connected', route: 'tailscale' },
    refusal: null,
    phoneOnline: true,
    syncedAt: 1,
    credentials: null,
  } as never;
  const codexAgent = agent({ id: 'c', engine: 'codex' });

  it('a Codex-only Mac is fine: no red Claude Code row, and the pill says Connected', () => {
    const s = {
      mac: mac(false),
      overview: { agents: [codexAgent], engines: engines({}) },
    } as never;
    const layers = engineLayers(s);
    expect(layers).toEqual([{ title: 'Codex', tone: 'ok', detail: 'Signed in' }]);
    expect(pill({ ...(base as object), ...(s as object) } as never).label).toBe('Connected');
  });

  it('a signed-out engine is named for what it is, and only matters with agents on it', () => {
    const s = {
      mac: mac(false),
      overview: { agents: [codexAgent], engines: engines({ signedIn: false }) },
    } as never;
    expect(pill({ ...(base as object), ...(s as object) } as never).label).toBe('Codex signed out');
    expect(engineLayers(s)[0]).toMatchObject({ title: 'Codex', tone: 'problem' });
    // Signed out with no agents on it is nothing to fix.
    const idle = {
      mac: mac(false),
      overview: { agents: [], engines: engines({ signedIn: false }) },
    };
    expect(pill({ ...(base as object), ...idle } as never).label).toBe('Connected');
  });

  it('an engine its agents need but that isn’t installed is the problem, said plainly', () => {
    const s = {
      mac: mac(false),
      overview: { agents: [agent({ engine: 'claude' })], engines: engines({}) },
    };
    expect(engineLayers(s as never)[0]).toMatchObject({ title: 'Claude Code', tone: 'problem' });
  });

  it('a Mac that sends no engine list falls back to its Claude Code status', () => {
    const s = { mac: mac(true, 'yes'), overview: { agents: [], engines: [] } } as never;
    expect(engineHealth(s)).toEqual([
      expect.objectContaining({ id: 'claude', installed: true, signedIn: 'yes' }),
    ]);
  });

  it('words a failed turn with the agent’s own engine', () => {
    expect(failureLine({ kind: 'signed_out' }, null, 'Codex')).toBe('Codex is signed out');
    expect(subtitle(agent({ engine: 'codex', failure: { kind: 'signed_out' } }))).toBe(
      'Codex is signed out'
    );
  });
});

describe('a refused send', () => {
  const pend: PendingSend = {
    clientId: 'c1',
    agentId: 'a',
    text: '!ls',
    ts: 100,
    failed: false,
    mentions: ['ops'],
    attachments: [{ blobId: 'b1', uri: 'file:///a', name: 'a.png', mime: 'image/png', size: 1 }],
  };
  const state = () => ({ ...emptySync(), pending: { a: [pend] } });

  it('keeps the Mac’s reason, and is final', () => {
    const s = setPendingFailed(
      state(),
      'a',
      'c1',
      true,
      false,
      'Commands starting with ! aren’t sent.'
    );
    expect(s.pending.a[0]).toMatchObject({
      failed: true,
      waiting: false,
      refused: true,
      reason: 'Commands starting with ! aren’t sent.',
    });
  });

  it('one that only waited too long stays yours to Send again: not refused', () => {
    const s = setPendingFailed(state(), 'a', 'c1', true);
    expect(s.pending.a[0].refused).toBeUndefined();
    expect(s.pending.a[0].reason).toBeUndefined();
  });

  it('goes back into the composer to edit: its words first, its mentions and its files', () => {
    const now = { ...EMPTY_DRAFT, text: 'and this' };
    const change = refusedToDraft({ ...pend, text: 'hey @Ops' }, now, [{ id: 'ops', name: 'Ops' }]);
    expect(change.text).toBe('hey @Ops\nand this');
    expect(change.mentions).toEqual([{ id: 'ops', name: 'Ops' }]);
    // Uploaded when it was sent: the Mac's hour is counted from then.
    expect(change.files).toEqual([{ ...pend.attachments![0], stagedAt: 100 }]);
  });
});

describe('Send, tapped twice', () => {
  it('takes the draft once: the second tap finds it emptied and sends nothing', () => {
    const draft = { ...EMPTY_DRAFT, text: '  ship it  ', quotes: ['the plan'] };
    const first = takeDraft(draft);
    expect(first?.body).toContain('ship it');
    expect(first?.body).toContain('the plan');
    // What the store holds after the first tap cleared it.
    expect(takeDraft(EMPTY_DRAFT)).toBeNull();
    expect(takeDraft(undefined)).toBeNull();
    expect(takeDraft({ ...EMPTY_DRAFT, text: '   ' })).toBeNull();
  });
});

describe('words', () => {
  it('calls a project’s agent tab a task, never its engine and a number', () => {
    expect(sessionLabel({ tab: 2 })).toBe('Task 2');
    expect(sessionLabel({ cli: 'codex', tab: 1 })).toBe('Task 1');
    expect(sessionLabel({ cli: 'claude' })).toBe('Task');
  });
});
