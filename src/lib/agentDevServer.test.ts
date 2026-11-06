import { describe, expect, it, vi } from 'vitest';
import { handleDevServerRequest, type DevServerOwner } from './agentDevServer';

function owner(over: Partial<DevServerOwner> = {}) {
  const state = { status: 'not-running' as const, address: null as string | null };
  const o: DevServerOwner = {
    status: vi.fn(() => ({ ...state })),
    start: vi.fn(async (_p: string, _n: string, port: number) => {
      Object.assign(state, { status: 'ready', address: `localhost:${port}` });
      return 'nextjs' as const;
    }),
    stop: vi.fn(async () => {
      Object.assign(state, { status: 'not-running', address: null });
    }),
    needsInstall: vi.fn(() => null),
    projectType: vi.fn(() => 'nextjs' as const),
    output: vi.fn(() => 'ready on 3100'),
    reservePort: vi.fn(async (_p: string, preferred: number) => preferred + 1),
    startProxy: vi.fn(async () => 51000),
    ...over,
  };
  return o;
}

const req = { requestId: 'r1', projectPath: '/u/ShipStudio/bakery', name: 'bakery' };

describe('handleDevServerRequest', () => {
  it('starts in the background on a reserved port and starts its proxy', async () => {
    const o = owner();
    const r = await handleDevServerRequest(o, { ...req, action: 'start', port: 3099 });
    expect(o.reservePort).toHaveBeenCalledWith('/u/ShipStudio/bakery', 3099);
    expect(o.start).toHaveBeenCalledWith('/u/ShipStudio/bakery', 'bakery', 3100);
    expect(o.startProxy).toHaveBeenCalledWith('/u/ShipStudio/bakery', 3100);
    expect(r).toMatchObject({ status: 'ready', port: 3100, projectType: 'nextjs', mobile: false });
    expect(r.output).toBe('ready on 3100');
  });

  it('reuses a server that is already up', async () => {
    const o = owner({
      status: vi.fn(() => ({ status: 'ready' as const, address: 'localhost:4000' })),
    });
    const r = await handleDevServerRequest(o, { ...req, action: 'start' });
    expect(o.start).not.toHaveBeenCalled();
    expect(o.startProxy).toHaveBeenCalledWith('/u/ShipStudio/bakery', 4000);
    expect(r.port).toBe(4000);
  });

  it('says when nothing started, without a proxy', async () => {
    const o = owner({
      start: vi.fn(async () => 'reactnative' as const),
      needsInstall: vi.fn(() => ({ packageManager: 'pnpm' })),
    });
    const r = await handleDevServerRequest(o, { ...req, action: 'start' });
    expect(o.startProxy).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      status: 'not-running',
      port: null,
      mobile: true,
      needsInstall: true,
    });
  });

  it('stops, and reports a failure instead of throwing', async () => {
    const o = owner();
    expect((await handleDevServerRequest(o, { ...req, action: 'stop' })).status).toBe(
      'not-running'
    );
    const broken = owner({ start: vi.fn(async () => Promise.reject(new Error('spawn failed'))) });
    const r = await handleDevServerRequest(broken, { ...req, action: 'start' });
    expect(r.error).toBe('spawn failed');
  });
});
