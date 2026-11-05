import type { Agent, AgentMessage, UsageTotals } from '@shipstudio/companion-protocol';
import type { NotificationRequest } from 'expo-notifications';
import {
  askingLine,
  attentionCounts,
  canStartFresh,
  contextLine,
  cardOutcome,
  describeScope,
  engineCantAsk,
  engineLine,
  subtitle,
  workingLine,
  needsLine,
  nextNeedsYou,
  usageLine,
} from '../src/lib/agents';
import { diffLineKind, questionContext } from '../src/lib/diff';
import { EMPTY_DRAFT, FILE_KEEP_MS, expiredFiles, putDraft } from '../src/lib/drafts';
import { badgeCount, notificationId, targetOf } from '../src/lib/notify';
import { agent } from './helpers';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';

const named = (id: string, over: Partial<Agent> = {}) =>
  agent({ id, name: id, hidden: false, pinned: false, ...over });
const approval = (id: string, status: 'pending' | 'allowed', detail = 'pnpm run deploy --prod') =>
  ({
    id,
    agentId: 'a',
    ts: 1,
    kind: 'approval',
    text: '',
    approval: { requestId: `r-${id}`, title: 'Run a command', detail, status },
  }) as AgentMessage;

describe('notifications', () => {
  const request = (data: unknown, trigger: unknown = null) =>
    ({ identifier: 'n', content: { data }, trigger }) as unknown as NotificationRequest;

  it('reads what a local alert, an APNs push and an FCM push are about', () => {
    expect(targetOf(request({ agentId: 'a', messageId: 'm', kind: 'approval' }))).toEqual({
      agentId: 'a',
      messageId: 'm',
      kind: 'approval',
    });
    expect(
      targetOf(request({}, { payload: { body: { agentId: 'b', kind: 'needs_you' } } }))
    ).toEqual({ agentId: 'b', kind: 'needs_you' });
    expect(targetOf(request(undefined, { remoteMessage: { data: { agentId: 'c' } } }))).toEqual({
      agentId: 'c',
    });
    expect(targetOf(request({ agentId: '' }))).toBeNull();
    expect(targetOf(undefined)).toBeNull();
  });

  it('gives the same alert the same identifier, so it replaces instead of stacking', () => {
    const alert = {
      agentId: 'a',
      messageId: 'm1',
      title: 'A',
      body: 'b',
      kind: 'approval',
    } as const;
    expect(notificationId(alert)).toBe('approval:m1');
    expect(notificationId({ ...alert, messageId: undefined })).toBeUndefined();
  });

  it('counts the badge as the desk does: unread plus approvals, hidden agents left out', () => {
    expect(
      badgeCount([
        named('a', { unread: 2, pendingApprovals: 1 }),
        named('b', { unread: 3, hidden: true }),
        named('c', { unread: 1, muted: true }),
      ])
    ).toBe(4);
  });
});

describe('attention', () => {
  it('says what a waiting agent is asking, only when the saved chat knows', () => {
    const a = named('a', { pendingApprovals: 1 });
    expect(needsLine(a, [approval('m1', 'pending')])).toBe(
      'Needs your OK · Wants to run its “deploy” script'
    );
    expect(needsLine(a, [approval('m1', 'allowed')])).toBe('Needs your OK');
    expect(needsLine(a, undefined)).toBe('Needs your OK');
  });

  it('never previews a diff: an edit says which file it wants to change', () => {
    expect(
      askingLine({
        title: 'Do you want to make this edit to Hero.tsx?',
        detail: '@@ -18,3 +18,3 @@\n-  <h1>Old</h1>\n+  <h1>New</h1>',
      })
    ).toBe('Wants to edit Hero.tsx');
    expect(
      askingLine({ title: 'Edit a file', detail: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@' })
    ).toBe('Edit a file');
    expect(askingLine({ title: 'Run a command', detail: 'npm test\n' })).toBe(
      'Wants to run the tests'
    );
    expect(askingLine({ title: 'Fetch a page', detail: '' })).toBe('Fetch a page');
  });

  it('counts who needs you and who is working, and finds the next card', () => {
    const agents = [
      named('idle'),
      named('busy', { status: { state: 'working', activity: null, since: 1 } }),
      named('old', { pendingApprovals: 1, lastActivityAt: 1 }),
      named('new', { pendingApprovals: 1, lastActivityAt: 9 }),
      named('gone', { pendingApprovals: 1, hidden: true, lastActivityAt: 99 }),
    ];
    expect(attentionCounts(agents)).toEqual({ needYou: 2, working: 1 });
    expect(nextNeedsYou(agents, { new: { messages: [approval('m9', 'pending')] } })).toEqual({
      agentId: 'new',
      messageId: 'm9',
    });
    expect(nextNeedsYou(agents.slice(0, 2), {})).toBeNull();
  });

  it('says where an always-allow can be revoked, except beside Revoke itself', () => {
    const scope = { kind: 'command_prefix', value: 'pnpm build', label: 'pnpm build' } as const;
    expect(describeScope(scope, 'Acme')).toMatch(/Revoke it any time from Acme’s sheet\.$/);
    expect(describeScope(scope, 'Acme', false)).not.toMatch(/Revoke/);
  });
});

describe('usage', () => {
  const totals = (over: Partial<UsageTotals>): UsageTotals => ({
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    pricedTurns: 0,
    durationMs: 0,
    ...over,
  });
  it('prices only the turns the Mac could price', () => {
    expect(usageLine(totals({}))).toBe('Nothing yet');
    // In a person's words: messages, never turns or tokens.
    expect(usageLine(totals({ turns: 3, inputTokens: 1500, costUsd: 0.4, pricedTurns: 3 }))).toBe(
      '3 messages · $0.40 at API prices'
    );
    expect(
      usageLine(totals({ turns: 4, inputTokens: 2_500_000, costUsd: 1, pricedTurns: 2 }))
    ).toBe('4 messages · $1.00 at API prices for 2 of them');
    expect(usageLine(totals({ turns: 1, outputTokens: 10 }))).toBe('1 message');
    // On a Claude plan the list price isn't the bill: its tokens instead.
    expect(
      usageLine(totals({ turns: 3, inputTokens: 1500, costUsd: 0.4, pricedTurns: 3 }), true)
    ).toBe('3 messages · 2k tokens');
    // A "When…" routine's model checks are said apart from messages.
    expect(
      usageLine(totals({ checks: 12, pricedChecks: 12, inputTokens: 900, costUsd: 0.05 }))
    ).toBe('12 checks · $0.05 at API prices');
    expect(
      usageLine(totals({ turns: 1, pricedTurns: 1, checks: 2, pricedChecks: 1, costUsd: 0.1 }))
    ).toBe('1 message · 2 checks · $0.10 at API prices for 2 of them');
  });
});

describe('diffs', () => {
  it('tints unified and Claude Code lines, not file headers', () => {
    expect(['@@ -1 +1 @@', '+a', '-b', ' c', '+++ b/x', '--- a/x'].map(diffLineKind)).toEqual([
      'hunk',
      'add',
      'del',
      'context',
      'context',
      'context',
    ]);
    expect(diffLineKind(' 13 -   return <header>')).toBe('del');
    expect(diffLineKind(' 14 +     <header className="sticky">')).toBe('add');
    expect(diffLineKind(' 12   export function Header() {')).toBe('context');
  });

  const question = {
    question: 'Do you want to make this edit to Header.tsx?',
    options: [{ key: '1', label: 'Yes', highlighted: true }],
  };

  it('finds the edit a session is asking about, out of its box', () => {
    const screen = [
      '> Make the header sticky.',
      '',
      '⏺ Update(src/components/Header.tsx)',
      '',
      '╭──────────────────────╮',
      '│ src/components/Header.tsx │',
      '│ 13 -   return <header> │',
      '│ 13 +   return <nav>    │',
      '╰──────────────────────╯',
      '',
      '  Do you want to make this edit to Header.tsx?',
      '  ❯ 1. Yes',
    ].join('\n');
    expect(questionContext(screen, question)).toEqual([
      'src/components/Header.tsx',
      '13 -   return <header>',
      '13 +   return <nav>',
    ]);
  });

  it('shows nothing when the question has scrolled off the screen', () => {
    expect(questionContext('⏺ Read(a)\n  ⎿ done', question)).toEqual([]);
  });
});

describe('draft files', () => {
  const file = (blobId: string, stagedAt: number) => ({
    blobId,
    uri: `file:///${blobId}`,
    name: `${blobId}.png`,
    mime: 'image/png',
    size: 1,
    stagedAt,
  });

  it('keeps a draft that is only a file, and drops it once the file is removed', () => {
    const d = putDraft({}, 'a', { files: [file('b1', 0)] });
    expect(d.a.files).toHaveLength(1);
    expect(putDraft(d, 'a', { files: [] })).toEqual({});
  });

  it('lets go of files the Mac no longer keeps', () => {
    const d = { ...EMPTY_DRAFT, files: [file('old', 0), file('new', FILE_KEEP_MS)] };
    expect(expiredFiles(d, FILE_KEEP_MS + 1).map((f) => f.blobId)).toEqual(['old']);
    // A draft saved before files were kept has none to lose.
    expect(expiredFiles({ text: 'x', quotes: [], mentions: [] })).toEqual([]);
  });
});

describe('engines, slots and decision cards', () => {
  const engines = real.agentsOverview.engines;

  it('names the engine and its model, and says nothing for an older Mac', () => {
    expect(engineLine(agent({ engine: 'claude', model: 'opus' }), engines)).toBe('Claude · Opus');
    expect(engineLine(agent({ engine: 'codex', model: 'gpt-5-codex' }), engines)).toBe(
      'Codex · GPT-5 Codex'
    );
    expect(engineLine(agent({ engine: 'codex', model: null }), engines)).toBe('Codex · Default');
    // A model the Mac doesn't list is shown as its id, not guessed.
    expect(engineLine(agent({ engine: 'claude', model: 'claude-x' }), engines)).toBe(
      'Claude · claude-x'
    );
    expect(engineLine(agent({ engine: undefined as never }), engines)).toBeNull();
  });

  it('says plainly when an agent’s engine can’t stop to ask, and only then', () => {
    const codex = agent({ engine: 'codex' });
    const old = engines.map((e) => (e.id === 'codex' ? { ...e, asks: false } : e));
    expect(engineCantAsk(codex, old)).toMatch(/needs your OK is refused/);
    expect(engineCantAsk(codex, engines)).toBeNull();
    // A Mac from before `asks` says nothing, so nothing is claimed.
    const older = engines.map(({ asks: _, ...e }) => e);
    expect(engineCantAsk(codex, older)).toBeNull();
    expect(engineCantAsk(agent({ engine: 'claude' }), old)).toBeNull();
  });

  it('says a queued turn is waiting for a slot and doesn’t count it as working', () => {
    const queued = agent({
      status: {
        state: 'working',
        activity: 'Waiting for a free slot (4 agents already working)',
        since: null,
      },
    });
    const running = agent({ id: 'b', status: { state: 'working', activity: 'Editing', since: 1 } });
    expect(workingLine(queued, true)).toBe('Waiting for a free slot');
    // A row cuts it where it reads, not inside the parenthesis.
    expect(subtitle(queued)).toBe('Waiting for a free slot · 4 busy');
    expect(workingLine(agent({ status: { state: 'working', activity: null, since: null } }))).toBe(
      'Waiting for a free slot'
    );
    expect(workingLine(running)).toBe('Editing');
    expect(attentionCounts([queued, running]).working).toBe(1);
  });

  it('words an answered session question with the option picked', () => {
    const base = { requestId: 'q', title: 't', detail: '' };
    expect(cardOutcome({ ...base, status: 'allowed', choice: 'Yes, proceed' })).toBe(
      'Allowed · Yes, proceed'
    );
    expect(cardOutcome({ ...base, status: 'denied', choice: 'No, exit' })).toBe(
      'Declined · No, exit'
    );
    expect(cardOutcome({ ...base, status: 'expired', choice: 'Yes' })).toBe('Not answered in time');
    expect(cardOutcome({ ...base, status: 'denied', note: 'use pnpm' })).toBe(
      'Declined · “use pnpm”'
    );
  });
});

describe('the conversation reading', () => {
  it('shows only what the engine reported, and offers a fresh start only when there is one to leave', () => {
    expect(contextLine(agent({ context: undefined }))).toBeNull();
    expect(contextLine(agent({ context: { used: 174_000, window: 200_000, at: 1 } }))).toBe(
      '87% full'
    );
    expect(contextLine(agent({ context: { used: 3_000, window: 1_000_000, at: 1 } }))).toBe(
      '<1% full'
    );
    expect(contextLine(agent({ context: { used: 10, window: 0, at: 1 } }))).toBeNull();
    expect(canStartFresh(agent({ sessionId: null }))).toBe(false);
    expect(canStartFresh(agent({ sessionId: 's1' }))).toBe(true);
    expect(canStartFresh(agent({ sessionId: null, newEngine: true }))).toBe(true);
    // The Mac's own serialization: a reading on the agent, none after a fresh start.
    expect(contextLine(real.agentsOverview.agents[0])).toBe('15% full');
    expect('context' in real.agentsStartFresh).toBe(false);
    expect(canStartFresh(real.agentsStartFresh)).toBe(false);
  });
});
