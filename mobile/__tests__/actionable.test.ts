/**
 * Allow / Deny from the Lock Screen (lib/actionable.ts): which cards get
 * buttons, that Allow always needs the phone unlocked, that nothing secret
 * reaches a notification, that the payload is ids only, and that an answer
 * that doesn't land is said, never dropped.
 */

import type { AgentMessage, Approval } from '@shipstudio/companion-protocol';
import {
  ACTION,
  CATEGORY,
  UNREACHABLE,
  answerFromAlert,
  answerOf,
  approvalNotice,
  categories,
  redact,
  type AnswerDeps,
} from '../src/lib/actionable';
import { msg } from './helpers';

const who = { id: 'site', name: 'Acme Site', muted: false, hidden: false };

const card = (over: Partial<Approval> = {}, status: Approval['status'] = 'pending'): AgentMessage =>
  msg('m1', 1, {
    agentId: 'site',
    kind: 'approval',
    text: '',
    approval: { requestId: 'r1', title: 'Run a command', detail: 'pnpm build', status, ...over },
  });

describe('categories', () => {
  it.each(['ios', 'android'])('%s: Deny never opens the app; every pair has both', (os) => {
    for (const c of categories(os).filter((x) => x.identifier !== CATEGORY.review)) {
      const deny = c.actions.find((x) => x.identifier === ACTION.deny);
      const allow = c.actions.find((x) => x.identifier === ACTION.allow);
      expect(deny?.options?.opensAppToForeground).toBe(false);
      expect(allow).toBeDefined();
    }
  });

  it('iOS asks for Face ID or the passcode before any Allow', () => {
    for (const c of categories('ios')) {
      const allow = c.actions.find((x) => x.identifier === ACTION.allow);
      if (allow) expect(allow.options?.isAuthenticationRequired).toBe(true);
    }
  });

  it('Android opens the app for Allow, which unlocks the phone', () => {
    for (const c of categories('android')) {
      const allow = c.actions.find((x) => x.identifier === ACTION.allow);
      if (allow) expect(allow.options?.opensAppToForeground).toBe(true);
    }
  });

  it('Review only opens, and has no Allow', () => {
    const review = categories('ios').find((c) => c.identifier === CATEGORY.review);
    expect(review?.actions.map((a) => a.identifier)).toEqual([ACTION.review]);
    expect(review?.actions[0].options?.opensAppToForeground).toBe(true);
  });
});

describe('approvalNotice', () => {
  it('a short plain request: its whole words and Deny · Allow; ids only in the data', () => {
    const n = approvalNotice(who, card());
    expect(n).toMatchObject({
      identifier: 'approval:m1',
      title: 'Acme Site',
      body: 'pnpm build',
      categoryIdentifier: CATEGORY.answer,
    });
    expect(n?.data).toEqual({
      agentId: 'site',
      messageId: 'm1',
      requestId: 'r1',
      kind: 'approval',
    });
  });

  it('uses the card’s own pair of words', () => {
    expect(approvalNotice(who, card({ gate: { routine: 'R' } as never }))?.categoryIdentifier).toBe(
      CATEGORY.gate
    );
    expect(approvalNotice(who, card({ handoff: {} as never }))?.categoryIdentifier).toBe(
      CATEGORY.handoff
    );
  });

  it('a long request only offers Review', () => {
    const detail = Array.from({ length: 20 }, (_, i) => `echo ${i}`).join('\n');
    const n = approvalNotice(who, card({ detail }));
    expect(n?.categoryIdentifier).toBe(CATEGORY.review);
    expect(n?.body.length).toBeLessThanOrEqual(180);
  });

  it('keys, logins, questions, step-ins and three-way cards never answer from a notification', () => {
    for (const over of [
      { secret: { name: 'STRIPE_SECRET_KEY' } },
      { login: { service: 'gmail', title: 'Gmail' } },
      { prompt: { options: [] } },
      { stepIn: { reason: 'r', site: 's', url: 'u', tab: 1 } },
      { crossover: {} },
      { connector: { kind: 'consent', source: 'Grok' } },
    ] as Partial<Approval>[]) {
      expect(approvalNotice(who, card(over))?.categoryIdentifier).toBe(CATEGORY.review);
    }
  });

  it('never puts a secret on the Lock Screen, and a card with one masked gets Review', () => {
    const detail = 'curl -H "Authorization: Bearer sk-live-abcdefghijklmnop1234" https://api.x.com';
    const n = approvalNotice(who, card({ detail, summary: undefined }));
    expect(n?.body).not.toContain('abcdefghijklmnop1234');
    expect(n?.subtitle ?? '').not.toContain('abcdefghijklmnop1234');
    expect(n?.categoryIdentifier).toBe(CATEGORY.review);
  });

  it('says nothing for an answered card, a muted agent or a hidden one', () => {
    expect(approvalNotice(who, card({}, 'allowed'))).toBeNull();
    expect(approvalNotice({ ...who, muted: true }, card())).toBeNull();
    expect(approvalNotice({ ...who, hidden: true }, card())).toBeNull();
    expect(approvalNotice(who, msg('x', 1, { kind: 'agent', text: 'hi' }))).toBeNull();
  });
});

describe('redact', () => {
  it.each([
    ['export STRIPE_KEY=sk_live_51HxyzABCDEFGHIJKLmnop', 'sk_live_51HxyzABCDEFGHIJKLmnop'],
    [
      'gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
    ],
    ['curl -H "Authorization: Bearer abc.def.ghi12345"', 'abc.def.ghi12345'],
    ['psql postgres://admin:hunter2@db.example.com/app', 'hunter2'],
    ['--password=correcthorse', 'correcthorse'],
    ['API_TOKEN: "zzz-qqq-123"', 'zzz-qqq-123'],
    ['AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['xoxb-123456789012-abcdefghij', 'xoxb-123456789012-abcdefghij'],
    [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
      'dozjgNryP4J3jVmNHl0w5N',
    ],
    ['key aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z'],
  ])('masks %s', (text, secret) => {
    const out = redact(text);
    expect(out.text).not.toContain(secret);
    expect(out.masked).toBe(true);
  });

  it('leaves plain commands alone', () => {
    for (const text of [
      'pnpm build',
      'git push origin main',
      'rm -rf ./dist',
      'ls ~/ShipStudio/acme-site',
    ]) {
      expect(redact(text)).toEqual({ text, masked: false });
    }
  });
});

describe('answering from a notification', () => {
  const deps = (over: Partial<AnswerDeps> = {}) => {
    const calls: string[] = [];
    const d: AnswerDeps = {
      waitLive: () => Promise.resolve(true),
      answer: (agentId, requestId, allow) =>
        Promise.resolve(void calls.push(`answer ${agentId} ${requestId} ${allow}`)),
      describe: (e) => (e instanceof Error ? e.message : String(e)),
      tell: (t, body) =>
        Promise.resolve(void calls.push(`tell ${t.agentId} ${t.messageId} ${body}`)),
      dismiss: (agentId, messageId) =>
        Promise.resolve(void calls.push(`dismiss ${agentId} ${messageId}`)),
      ...over,
    };
    return { d, calls };
  };
  const target = { agentId: 'site', messageId: 'm1', requestId: 'r1' };

  it('maps the buttons, and a plain tap is not an answer', () => {
    expect(answerOf(ACTION.allow)).toBe(true);
    expect(answerOf(ACTION.deny)).toBe(false);
    expect(answerOf(ACTION.review)).toBeNull();
    expect(answerOf('expo.modules.notifications.actions.DEFAULT')).toBeNull();
  });

  it('answers through the Mac, then takes the notification back', async () => {
    const { d, calls } = deps();
    await expect(answerFromAlert(target, true, d)).resolves.toBe('answered');
    expect(calls).toEqual(['answer site r1 true', 'dismiss site m1']);
  });

  it('says so when the card was already answered (one answer per card)', async () => {
    const { d, calls } = deps({
      answer: () => Promise.reject(new Error('That request was already answered.')),
    });
    await expect(answerFromAlert(target, false, d)).resolves.toBe('refused');
    expect(calls).toEqual([
      'tell site m1 Not denied from here: That request was already answered.',
    ]);
  });

  it('says so when the Mac can’t be reached, and sends nothing', async () => {
    const { d, calls } = deps({ waitLive: () => Promise.resolve(false) });
    await expect(answerFromAlert(target, true, d)).resolves.toBe('unreachable');
    expect(calls).toEqual([`tell site m1 ${UNREACHABLE}`]);
  });

  it('never answers without the request id', async () => {
    const { d, calls } = deps();
    await expect(answerFromAlert({ agentId: 'site', messageId: 'm1' }, true, d)).resolves.toBe(
      'unreachable'
    );
    expect(calls.some((c) => c.startsWith('answer'))).toBe(false);
  });
});
