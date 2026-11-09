/**
 * A throw out of a socket callback ends a release build, so a frame the
 * phone can't handle (from a Mac of another version, or one a listener trips
 * on) is reported and skipped: the connection, and every other listener, go on.
 */

import type { CompanionEvent } from '@shipstudio/companion-protocol';
import { WebSocket } from 'ws';
import { createMockServer } from '../dev/mock-server';
import { until, provenBy } from './helpers';
import { DirectTransport, setTransportFaultReporter } from '../src/lib/transport';

jest.setTimeout(20_000);

describe('a frame the phone can’t handle', () => {
  const mock = createMockServer({ quiet: true, allowAfterMs: 0, draftEveryMs: 15 });
  let transport: DirectTransport;
  const faults: unknown[] = [];
  const seen: CompanionEvent[] = [];
  let caughtUp = false;

  beforeAll(async () => {
    setTransportFaultReporter((e) => faults.push(e));
    const url = await mock.listen();
    const { token } = mock.issueToken();
    transport = new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => undefined,
      foreground: true,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      ...provenBy(mock),
    });
    // The first listener trips on everything; the second must still hear it all.
    transport.onEvent(() => {
      throw new Error('listener tripped');
    });
    transport.onEvent((e) => {
      seen.push(e);
      if (e.type === 'sync.caughtUp') caughtUp = true;
    });
    await until(() => caughtUp);
  });

  afterAll(async () => {
    setTransportFaultReporter(() => {});
    transport.close();
    await mock.close();
  });

  it('reports a listener that throws, and the others still hear every event', () => {
    expect(seen.some((e) => e.type === 'sync.snapshot')).toBe(true);
    expect(faults.length).toBeGreaterThan(0);
    expect(transport.state.kind).toBe('connected');
  });

  it('skips frames that aren’t frames, or events that aren’t events', () => {
    const ws = (transport as unknown as { ws: { onmessage: (ev: { data: unknown }) => void } }).ws;
    const before = seen.length;
    for (const data of [
      'null',
      '3',
      '[]',
      '{"t":7}',
      '{"t":"evt"}',
      '{"t":"evt","event":null}',
      '{"t":"evt","event":{"type":"sync.snapshot"}}',
      '{"t":"res","id":"nobody"}',
      'not json',
    ]) {
      expect(() => ws.onmessage({ data })).not.toThrow();
    }
    // The snapshot without a cursor threw inside, was reported, and went nowhere.
    expect(seen.length).toBe(before);
    expect(transport.state.kind).toBe('connected');
  });
});
