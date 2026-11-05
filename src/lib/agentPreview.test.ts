import { describe, expect, it } from 'vitest';
import {
  paneState,
  portOf,
  pushLocation,
  runLine,
  type PreviewRun,
  type PreviewTarget,
} from './agentPreview';

const target: PreviewTarget = {
  agentId: 'site',
  messageId: 'm1',
  path: '/p/.worktrees/harbor-bakery/site-1',
  project: '/p/harbor-bakery',
  copy: true,
  port: 4210,
  running: false,
  title: 'New hero section',
};

const base = {
  error: null,
  target,
  consentPending: false,
  needsInstall: null,
  projectType: 'nextjs' as const,
  server: { status: 'not-running', address: null },
  port: 4210,
  startSettled: false,
};

describe('what the pane shows', () => {
  it('waits for the card to resolve, and a failure beats everything', () => {
    expect(paneState({ ...base, target: null })).toEqual({ kind: 'resolving' });
    expect(paneState({ ...base, error: 'gone', consentPending: true })).toEqual({
      kind: 'failed',
      message: 'gone',
    });
  });

  it('says it is waiting for the OK or for dependencies, never just "starting"', () => {
    expect(paneState({ ...base, consentPending: true, startSettled: true }).kind).toBe('consent');
    expect(
      paneState({ ...base, needsInstall: { packageManager: 'pnpm' }, startSettled: true })
    ).toEqual({ kind: 'install', packageManager: 'pnpm' });
  });

  it('is starting until the server answers, then ready on its own port', () => {
    expect(paneState(base).kind).toBe('starting');
    expect(
      paneState({ ...base, server: { status: 'starting', address: 'localhost:4210' } }).kind
    ).toBe('starting');
    expect(paneState({ ...base, server: { status: 'ready', address: 'localhost:4311' } })).toEqual({
      kind: 'ready',
      port: 4311,
    });
  });

  it('shows a server another window already runs without starting one', () => {
    expect(paneState({ ...base, target: { ...target, running: true }, server: null })).toEqual({
      kind: 'ready',
      port: 4210,
    });
  });

  it('a folder with nothing to run, or a phone app, has no preview here', () => {
    expect(paneState({ ...base, startSettled: true }).kind).toBe('no-preview');
    expect(paneState({ ...base, projectType: 'reactnative' }).kind).toBe('no-preview');
  });

  it('a server that died says so', () => {
    expect(paneState({ ...base, server: { status: 'stopped', address: null } }).kind).toBe(
      'stopped'
    );
  });
});

describe('small rules', () => {
  it('reads the port from an address only when it is one', () => {
    expect(portOf('localhost:4100')).toBe(4100);
    expect(portOf(null)).toBeNull();
    expect(portOf('localhost:99999')).toBeNull();
    expect(portOf('localhost')).toBeNull();
  });

  it('Back remembers pages without repeats in a row', () => {
    let h: string[] = [];
    for (const l of ['/', '/', '/pricing', '/pricing', '/signup']) h = pushLocation(h, l);
    expect(h).toEqual(['/', '/pricing', '/signup']);
    expect(pushLocation(['/a', '/b'], '/c', 2)).toEqual(['/b', '/c']);
  });

  it('the steps column says where the test is', () => {
    const run: PreviewRun = {
      id: 'r',
      agentId: 'site',
      messageId: 'm1',
      path: target.path,
      project: target.project,
      copy: true,
      startedAt: 1,
      state: 'running',
      steps: [],
    };
    expect(runLine(null)).toBeNull();
    expect(runLine(run)).toBe('Starting the test…');
    expect(runLine({ ...run, steps: [{ kind: 'open', label: 'Opened /', ok: true, ts: 1 }] })).toBe(
      'Testing…'
    );
    expect(runLine({ ...run, state: 'reported', outcome: 'broken' })).toBe(
      'Found something broken'
    );
    expect(runLine({ ...run, state: 'reported', outcome: 'passed' })).toBe('It works');
    expect(runLine({ ...run, state: 'stopped' })).toBe('The test stopped');
  });
});
