/**
 * Login cards on the phone: the card's phases and words, held as pure
 * functions, and the round trip against the mock Mac through the app's real
 * transport: Connect starts the sign-in "on the Mac", the card says so on
 * this phone, and it turns connected when the Mac says so. Plus "What your
 * team needs" (one row per service) and "What it can reach".
 */

import type {
  AgentMessage,
  Approval,
  CompanionEvent,
  Cursor,
  LoginRequest,
  TeamCard,
} from '@shipstudio/companion-protocol';
import { WebSocket } from 'ws';
import { createMockServer, loginCard } from '../dev/mock-server';
import { until, provenBy } from './helpers';
import {
  loginOutcome,
  loginPhase,
  onMacLine,
  otherOptions,
  phoneDetail,
  phoneWay,
  servesPhoneSignIn,
  primaryOption,
  reachRows,
  servesLogins,
  teamCardLine,
  teamProgress,
} from '../src/lib/loginState';
import { applyEvent, emptySync } from '../src/lib/sync';
import { DirectTransport } from '../src/lib/transport';

jest.setTimeout(20_000);

const approval = (over: Partial<Approval> = {}): Approval => ({
  requestId: 'r1',
  title: 'Finance needs your Gmail',
  detail: 'Read invoices',
  status: 'pending',
  ...over,
});

describe('a login card, in words', () => {
  const gmail = loginCard('Finance', 'gmail');
  const linkedin = loginCard('Social', 'linkedin');

  it('leads with the browser, and offers claude.ai’s connector as an extra', () => {
    expect(primaryOption(gmail)?.method).toBe('browser');
    expect(otherOptions(gmail).map((o) => o.method)).toEqual(['claude_ai']);
    // No connector: the browser leads, and the card says why there's no connector.
    expect(primaryOption(linkedin)?.method).toBe('browser');
    expect(linkedin.noConnector).toMatch(/no connector/);
  });

  it('is choosing, on the Mac, failed or answered', () => {
    const flow = (state: NonNullable<LoginRequest['flow']>['state']): LoginRequest => ({
      ...gmail,
      flow: { state, option: 'claude_ai', startedAt: 0, fromPhone: true },
    });
    expect(loginPhase(approval(), gmail)).toBe('choose');
    expect(loginPhase(approval(), flow('starting'))).toBe('onMac');
    expect(loginPhase(approval(), flow('waiting'))).toBe('onMac');
    expect(loginPhase(approval(), flow('failed'))).toBe('failed');
    // Cancelled is back to choosing: nothing happened.
    expect(loginPhase(approval(), flow('cancelled'))).toBe('choose');
    expect(loginPhase(approval({ status: 'allowed' }), flow('waiting'))).toBe('answered');
    expect(onMacLine({ ...gmail, flow: { state: 'waiting', option: 'x', startedAt: 0, message: 'Open on claude.ai.' } })).toBe(
      'Finish signing in on your Mac — it’s open there. Open on claude.ai.'
    );
  });

  it('says how it was answered', () => {
    expect(loginOutcome(approval({ status: 'allowed', choice: 'Connected · Gmail (work@acme.com)' }), gmail, 'Finance')).toBe(
      'Connected · Gmail (work@acme.com)'
    );
    expect(loginOutcome(approval({ status: 'denied' }), gmail, 'Finance')).toBe('Declined · Finance was told');
    expect(loginOutcome(approval({ status: 'denied', note: 'Not needed' }), gmail, 'Finance')).toMatch(/^Not needed · /);
    expect(loginOutcome(approval({ status: 'expired', note: 'Moved' }), gmail, 'Finance')).toBe('Closed · Moved');
  });

  it('uses the login methods only on a Mac that says it serves them', () => {
    expect(servesLogins({ methods: ['agents.loginStart'], features: ['logins'] } as never)).toBe(true);
    expect(servesLogins({ methods: ['agents.loginStart'], features: [] } as never)).toBe(false);
    expect(servesLogins({ methods: [], features: ['logins'] } as never)).toBe(false);
    expect(servesLogins(null)).toBe(false);
  });

  it('reads the team progress and each agent’s line', () => {
    expect(teamProgress({ done: 4, total: 9 })).toBe('4 of 9 connected');
    expect(teamProgress({ done: 2, total: 2 })).toBe('All 2 done');
    expect(teamProgress({ done: 0, total: 0 })).toBe('Nothing waiting');
    const card: TeamCard = {
      agentId: 'a',
      agentName: 'Recruiter',
      requestId: 'r',
      service: 'gmail',
      title: 'Gmail',
      abilities: [{ id: 'read', label: 'Read' }, { id: 'write', label: 'Send' }],
      state: 'waiting',
    };
    expect(teamCardLine(card)).toBe('Recruiter · to read and send Gmail');
    expect(teamCardLine({ ...card, flow: { state: 'waiting', option: 'x', startedAt: 0 } })).toBe(
      'Recruiter · Signing in on your Mac…'
    );
    expect(teamCardLine({ ...card, state: 'skipped', outcome: 'Not needed' })).toBe('Recruiter · Not needed');
  });

  it('signs in here when the Mac lets it, and says where the sign-in is kept', () => {
    const o = (method: LoginRequest['options'][number]['method']) => ({ id: method, method, label: 'x', detail: 'On the Mac.' });
    // A Mac with logins.phone and a build with the sign-in sheet.
    expect(phoneWay(o('oauth'), true, true)).toBe('sheet');
    expect(phoneWay(o('gh'), true, true)).toBe('device');
    expect(phoneWay(o('claude_ai'), true, true)).toBe('web');
    expect(phoneWay(o('existing'), true, true)).toBe('tap');
    expect(phoneWay(o('browser'), false, false)).toBe('tap');
    expect(phoneWay(o('key'), false, false)).toBe('key');
    // An installed build without the sheet: OAuth falls back to the Mac, the rest still work here.
    expect(phoneWay(o('oauth'), true, false)).toBe('mac');
    expect(phoneWay(o('gh'), true, false)).toBe('device');
    // An older Mac: everything that signs in finishes there, as before.
    for (const m of ['oauth', 'gh', 'claude_ai'] as const) expect(phoneWay(o(m), false, true)).toBe('mac');
    expect(phoneDetail(o('oauth'), 'sheet', 'Linear')).toMatch(/Keychain; this phone keeps nothing/);
    expect(phoneDetail(o('claude_ai'), 'web', 'Gmail')).toMatch(/claude\.ai holds that sign-in, not your Mac/);
    expect(phoneDetail(o('oauth'), 'mac', 'Linear')).toBe('On the Mac. Finish on your Mac.');
    expect(servesPhoneSignIn({ methods: ['agents.loginPhoneBegin'], features: ['logins.phone'] } as never)).toBe(true);
    expect(servesPhoneSignIn({ methods: ['agents.loginPhoneBegin'], features: ['logins'] } as never)).toBe(false);
    // A sign-in on this phone says so, not "on your Mac".
    expect(
      onMacLine({ ...gmail, flow: { state: 'waiting', option: 'gh', startedAt: 0, onPhone: true, userCode: 'AB12-CD34' } })
    ).toBe('Signing in to Gmail here.');
    const card: TeamCard = {
      agentId: 'a', agentName: 'Design', requestId: 'r', service: 'github', title: 'GitHub',
      abilities: [{ id: 'read', label: 'Read' }], state: 'waiting',
      flow: { state: 'waiting', option: 'gh', startedAt: 0, onPhone: true },
    };
    expect(teamCardLine(card)).toBe('Design · Signing in on your phone…');
  });

  it('lists what an agent can reach, never a token', () => {
    const rows = reachRows({
      connections: [
        { connectionId: 'c1', service: 'gmail', title: 'Gmail', account: 'work@acme.com', access: 'read', kept: 'Held on claude.ai', needsSignIn: false },
        { connectionId: 'c2', service: 'linear', title: 'Linear', account: 'Linear', access: 'full', kept: 'In your Mac’s Keychain', needsSignIn: true },
      ],
      browser: { on: true, teamOn: true, ownOff: false, sites: ['www.linkedin.com'], helperInstalled: false },
      secrets: [{ secretId: 's1', name: 'x_key', purpose: 'Post', variables: ['$X_KEY'] }],
      blockedApps: ['figma'],
    });
    expect(rows.map((r) => r.label)).toEqual(['Gmail · work@acme.com', 'Linear', 'Your browser', 'x_key', 'figma']);
    expect(rows[1]).toMatchObject({ warning: true, detail: 'Needs signing in again on your Mac' });
    expect(rows[2].detail).toMatch(/www\.linkedin\.com.*isn’t set up/);
  });
});

describe('login cards against the mock Mac', () => {
  const mock = createMockServer({ quiet: true, allowAfterMs: 0, draftEveryMs: 10, loginAfterMs: 150 });
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

  const card = async (agentId: string, requestId: string) =>
    (await t.request('agents.messages', { agentId })).messages.find(
      (m: AgentMessage) => m.approval?.requestId === requestId
    )!;

  it('advertises logins', async () => {
    await until(() => !!t.welcome);
    expect(servesLogins(t.welcome)).toBe(true);
  });

  it('groups the team’s asks by service, Gmail with Calendar', async () => {
    const team = await t.request('agents.loginsTeam', {});
    const google = team.needs.find((n) => n.key === 'google')!;
    expect(google.cards.map((c) => c.agentName).sort()).toEqual(['Finance', 'QA 2']);
    expect(google.options[0].method).toBe('browser');
    expect(team.needs.find((n) => n.key === 'linkedin')!.options.map((o) => o.method)).toEqual(['browser']);
  });

  it('starts on the Mac, says so here, and turns connected', async () => {
    await t.request('agents.loginStart', { agentId: 'fin', requestId: 'req_login_gmail', optionId: 'claude_ai' });
    const waiting = await card('fin', 'req_login_gmail');
    expect(loginPhase(waiting.approval!, waiting.approval!.login!)).toBe('onMac');
    expect(waiting.approval!.login!.flow).toMatchObject({ state: 'waiting', fromPhone: true });
    for (let i = 0; i < 100 && (await card('fin', 'req_login_gmail')).approval!.status !== 'allowed'; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    const done = await card('fin', 'req_login_gmail');
    expect(done.approval!.choice).toMatch(/^Connected · Gmail/);
    expect(done.approval!.login!.flow).toBeUndefined();
    const reach = await t.request('agents.reach', { agentId: 'fin' });
    expect(reach.connections.map((c) => c.title)).toEqual(['Gmail']);
  });

  it('signs in on the phone: the sheet’s code goes to the Mac once, on its own redirect', async () => {
    await until(() => !!t.welcome);
    expect(servesPhoneSignIn(t.welcome)).toBe(true);
    const begun = await t.request('agents.loginPhoneBegin', {
      agentId: 'design',
      requestId: 'req_login_linear',
      optionId: 'oauth',
    });
    expect(begun.redirectUri).toBe('dashbot-companion://oauth');
    expect((await card('design', 'req_login_linear')).approval!.login!.flow).toMatchObject({ onPhone: true });
    const state = new URL(begun.url).searchParams.get('state');
    // The wrong redirect is refused, and the sign-in is spent.
    await expect(
      t.request('agents.loginPhoneFinish', { flowId: begun.flowId, callbackUrl: `https://evil.test/oauth?code=c&state=${state}` })
    ).rejects.toBeTruthy();
    await expect(
      t.request('agents.loginPhoneFinish', { flowId: begun.flowId, callbackUrl: `dashbot-companion://oauth?code=c&state=${state}` })
    ).rejects.toBeTruthy();
    const again = await t.request('agents.loginPhoneBegin', { agentId: 'design', requestId: 'req_login_linear', optionId: 'oauth' });
    const s2 = new URL(again.url).searchParams.get('state');
    await t.request('agents.loginPhoneFinish', { flowId: again.flowId, callbackUrl: `dashbot-companion://oauth?code=c&state=${s2}` });
    expect((await card('design', 'req_login_linear')).approval!.choice).toMatch(/^Connected · Linear/);
    // claude.ai on the phone: the Mac watches for it, its browser left shut.
    await t.request('agents.loginStart', { agentId: 'qa', requestId: 'req_login_gmail_qa', optionId: 'claude_ai', onPhone: true });
    expect((await card('qa', 'req_login_gmail_qa')).approval!.login!.flow).toMatchObject({ onPhone: true, state: 'waiting' });
    await t.request('agents.loginCancel', { agentId: 'qa', requestId: 'req_login_gmail_qa' });
  });

  it('cancels, declines and puts away', async () => {
    await t.request('agents.loginCancel', { agentId: 'qa', requestId: 'req_login_gmail_qa' });
    const cancelled = await card('qa', 'req_login_gmail_qa');
    expect(loginPhase(cancelled.approval!, cancelled.approval!.login!)).toBe('choose');
    await t.request('agents.loginDismiss', { agentId: 'qa', requestId: 'req_login_linkedin' });
    const put = await card('qa', 'req_login_linkedin');
    expect(put.approval).toMatchObject({ status: 'denied', note: 'Not needed' });
    await expect(
      t.request('agents.loginStart', { agentId: 'qa', requestId: 'req_login_linkedin', optionId: 'browser' })
    ).rejects.toBeTruthy();
  });
});
