/**
 * The Mac's alerts, posted (lib/liveAlerts.ts): an approval with its card's
 * own category and words whichever arrives first, a reply as said and
 * redacted, once, never in front of that chat, and the relay's banner for
 * the same agent taken back. The last case goes through the real `post`
 * to Notification Center.
 */

import type { AgentMessage, Alert, Approval } from '@shipstudio/companion-protocol';
import * as Notifications from 'expo-notifications';
import { CATEGORY, type ApprovalNotice } from '../src/lib/actionable';
import { LiveAlerts, defaultDeps, type LiveAlertDeps } from '../src/lib/liveAlerts';
import { msg } from './helpers';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve('id')),
  getPresentedNotificationsAsync: jest.fn(() => Promise.resolve([])),
  dismissNotificationAsync: jest.fn(() => Promise.resolve()),
}));

const site = { id: 'site', name: 'Acme Site', muted: false, hidden: false };

const card = (over: Partial<Approval> = {}, status: Approval['status'] = 'pending'): AgentMessage =>
  msg('m1', 1, {
    agentId: 'site',
    kind: 'approval',
    text: '',
    approval: { requestId: 'r1', title: 'Run a command', detail: 'pnpm build', status, ...over },
  });

const approvalAlert: Alert = {
  agentId: 'site',
  messageId: 'm1',
  title: 'Acme Site',
  body: 'Needs your OK: Run a command',
  kind: 'approval',
};

function setup(over: Pick<Partial<LiveAlertDeps>, 'agent' | 'inFront'> = {}) {
  const deps = {
    agent: over.agent ?? ((id: string) => (id === site.id ? site : undefined)),
    inFront: over.inFront ?? (() => false),
    post: jest.fn((_: Alert) => Promise.resolve()),
    postNotice: jest.fn((_: ApprovalNotice) => Promise.resolve(true)),
    dismissPushFor: jest.fn((_: string, __: string[]) => Promise.resolve()),
    now: () => 1000,
  };
  return { deps, live: new LiveAlerts(deps) };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('an approval', () => {
  it('posts its card with Allow / Deny when the card came first', async () => {
    const { deps, live } = setup();
    live.heard(card());
    await live.alert(approvalAlert);
    expect(deps.post).not.toHaveBeenCalled();
    expect(deps.postNotice).toHaveBeenCalledTimes(1);
    const notice = deps.postNotice.mock.calls[0][0] as {
      categoryIdentifier: string;
      identifier: string;
    };
    expect(notice.categoryIdentifier).toBe(CATEGORY.answer);
    expect(notice.identifier).toBe('approval:m1');
    expect(deps.dismissPushFor).toHaveBeenCalledWith('site', ['needs_you']);
  });

  it('posts plainly, then the card replaces it, when the alert came first', async () => {
    const { deps, live } = setup();
    await live.alert(approvalAlert);
    expect(deps.post).toHaveBeenCalledTimes(1);
    live.heard(card());
    await Promise.resolve();
    expect(deps.postNotice).toHaveBeenCalledTimes(1);
  });

  it('a key or login card gets Review, and an "OK to go on?" its own words', async () => {
    const { deps, live } = setup();
    live.heard({ ...card({ secret: { name: 'STRIPE_SECRET_KEY' } as never }), id: 'k1' });
    await live.alert({ ...approvalAlert, messageId: 'k1' });
    live.heard({ ...card({ gate: { routine: 'R' } as never }), id: 'g1' });
    await live.alert({ ...approvalAlert, messageId: 'g1' });
    const cats = deps.postNotice.mock.calls.map(
      (c) => (c[0] as { categoryIdentifier: string }).categoryIdentifier
    );
    expect(cats).toEqual([CATEGORY.review, CATEGORY.gate]);
  });

  it('an answered card is never posted late', async () => {
    const { deps, live } = setup();
    await live.alert(approvalAlert);
    live.heard(card({}, 'allowed'));
    live.heard(card());
    await Promise.resolve();
    expect(deps.postNotice).not.toHaveBeenCalled();
  });

  it('nothing for a muted or hidden agent', async () => {
    const { deps, live } = setup({ agent: () => ({ ...site, muted: true }) });
    live.heard(card());
    await live.alert(approvalAlert);
    await live.alert({ ...approvalAlert, messageId: 'm2' });
    expect(deps.postNotice).not.toHaveBeenCalled();
    expect(deps.post).not.toHaveBeenCalled();
  });
});

describe('a reply', () => {
  const reply: Alert = {
    agentId: 'site',
    messageId: 'm5',
    title: 'Acme Site',
    body: 'Deployed with token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
    kind: 'reply',
  };

  it('posts redacted, once, and takes back the relay banner', async () => {
    const { deps, live } = setup();
    await live.alert(reply);
    await live.alert(reply);
    expect(deps.post).toHaveBeenCalledTimes(1);
    const posted = deps.post.mock.calls[0][0];
    expect(posted.body).not.toContain('ghp_0123456789');
    expect(posted.messageId).toBe('m5');
    expect(deps.dismissPushFor).toHaveBeenCalledWith('site', ['finished', 'message']);
  });

  it('nothing with that chat open in front', async () => {
    const { deps, live } = setup({ inFront: (id) => id === 'site' });
    await live.alert(reply);
    expect(deps.post).not.toHaveBeenCalled();
  });

  it('reaches Notification Center under its agent, with ids only in its data', async () => {
    const live = new LiveAlerts(
      defaultDeps(
        () => site,
        () => false
      )
    );
    await live.alert(reply);
    const schedule = Notifications.scheduleNotificationAsync as jest.MockedFunction<
      typeof Notifications.scheduleNotificationAsync
    >;
    expect(schedule).toHaveBeenCalledTimes(1);
    const req = schedule.mock.calls[0][0] as Notifications.NotificationRequestInput & {
      identifier: string;
      content: { threadIdentifier: string; data: unknown; body: string };
    };
    expect(req.identifier).toBe('reply:m5');
    expect(req.content.threadIdentifier).toBe('site');
    expect(req.content.data).toEqual({ agentId: 'site', messageId: 'm5', kind: 'reply' });
    expect(req.content.body).not.toContain('ghp_0123456789');
  });
});
