/**
 * The demo (lib/demo.ts): sample agents with no Mac and no network, for App
 * Review and anyone without a Mac to pair. It must say what it is, offer
 * only what it answers, and never pass for a real Mac.
 */
import type { CompanionEvent, WelcomeFrame } from '@shipstudio/companion-protocol';
import {
  DEMO_MAC_NAME,
  DEMO_METHODS,
  DEMO_REPLY,
  DEMO_SERVER_ID,
  DemoTransport,
  NOT_IN_DEMO,
  demoCredentials,
  isDemo,
} from '../src/lib/demo';

function start() {
  const t = new DemoTransport(() => 1_762_300_000_000);
  const events: CompanionEvent[] = [];
  const welcomes: WelcomeFrame[] = [];
  t.onEvent((e) => events.push(e));
  t.onWelcome((w) => welcomes.push(w));
  jest.advanceTimersByTime(0);
  return { t, events, welcomes };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('the demo', () => {
  it('is named as the demo, with nothing to reach and no secret', () => {
    const c = demoCredentials();
    expect(isDemo(c)).toBe(true);
    expect(c.name).toBe(DEMO_MAC_NAME);
    expect(c.routes).toEqual([]);
    expect(c.token).toBe('');
    expect(isDemo({ serverId: 'srv_real' })).toBe(false);
    expect(isDemo(null)).toBe(false);
  });

  it('opens like a Mac: welcome with only its methods, a snapshot, then caught up', () => {
    const { t, events, welcomes } = start();
    expect(t.state.kind).toBe('connected');
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0].server).toMatchObject({ id: DEMO_SERVER_ID, name: DEMO_MAC_NAME });
    expect(welcomes[0].methods).toEqual([...DEMO_METHODS]);
    // Nothing that sends, signs in, keeps a secret or registers push.
    for (const m of ['devices.setPush', 'agents.saveSecret', 'agents.loginStart', 'sessions.send'])
      expect(welcomes[0].methods).not.toContain(m);
    expect(events.map((e) => e.type)).toEqual(['sync.snapshot', 'sync.caughtUp']);
    const snap = events[0] as Extract<CompanionEvent, { type: 'sync.snapshot' }>;
    expect(snap.overview?.agents.map((a) => a.name)).toContain('Chief of Staff');
    expect(snap.status.name).toBe(DEMO_MAC_NAME);
    expect(t.identityVerified).toBe(false);
  });

  it('refuses what it doesn’t offer, saying it’s the demo', async () => {
    const { t } = start();
    await expect(t.request('agents.memory', { agentId: 'chief' })).rejects.toThrow(NOT_IN_DEMO);
    await expect(
      t.upload({ uri: 'file:///x.png', name: 'x.png', mime: 'image/png' })
    ).rejects.toThrow(NOT_IN_DEMO);
  });

  it('answers a message with the demo’s reply, once per clientId', async () => {
    const { t, events } = start();
    const sent = await t.request('agents.send', {
      agentId: 'research',
      text: 'Ask Hillside for a sample',
      clientId: 'c1',
    });
    expect(sent).toMatchObject({ kind: 'user', clientId: 'c1' });
    expect(await t.request('agents.send', { agentId: 'research', text: 'x', clientId: 'c1' })).toBe(
      sent
    );
    jest.advanceTimersByTime(2000);
    const replies = events.filter(
      (e) => e.type === 'agents.message' && e.message.kind === 'agent'
    ) as Extract<CompanionEvent, { type: 'agents.message' }>[];
    expect(replies.map((e) => e.message.text)).toEqual([DEMO_REPLY]);
  });

  it('answers its card, and says nothing was sent', async () => {
    const { t, events } = start();
    await t.request('agents.answerApproval', {
      agentId: 'inbox',
      requestId: 'demo_send_dana',
      allow: true,
    });
    jest.advanceTimersByTime(1000);
    const texts = events
      .filter((e) => e.type === 'agents.message')
      .flatMap((e) => (e.type === 'agents.message' ? [e.message] : []));
    expect(texts[0].approval?.status).toBe('allowed');
    expect(texts[1].text).toMatch(/In the demo nothing is sent/);
    await expect(
      t.request('agents.answerApproval', {
        agentId: 'inbox',
        requestId: 'demo_send_dana',
        allow: true,
      })
    ).rejects.toThrow('already answered');
  });

  it('goes quiet when closed', async () => {
    const { t, events } = start();
    await t.request('agents.send', { agentId: 'chief', text: 'hi', clientId: 'c2' });
    const before = events.length;
    t.close();
    jest.advanceTimersByTime(5000);
    expect(events.length).toBe(before);
  });
});
