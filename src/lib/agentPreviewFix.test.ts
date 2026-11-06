import { describe, expect, it } from 'vitest';
import {
  FIX_GRACE_MS,
  OWNER_WAIT_MS,
  paneAgentFor,
  registerPreviewPane,
  stoppedView,
  type PreviewFix,
} from './agentPreviewFix';
import { onDevServerExit, reportDevServerExit } from './devServerExits';

const NOW = 1_000_000;
const fix = (phase: PreviewFix['phase'], at = NOW): PreviewFix => ({
  path: '/p/site',
  agentId: 'site',
  agentName: 'Site Builder',
  phase,
  reason: 'a compile error',
  at,
});

describe('stoppedView', () => {
  it('waits briefly to hear who owns it, then keeps the workspace line', () => {
    const base = { fix: null, ownerWorking: false, stoppedAt: NOW };
    expect(stoppedView({ ...base, now: NOW }).kind).toBe('waiting');
    expect(stoppedView({ ...base, now: NOW + OWNER_WAIT_MS }).kind).toBe('workspace');
  });

  it('is fixing while the turn runs, or for a short grace before it starts', () => {
    const f = fix('fixing');
    expect(stoppedView({ fix: f, ownerWorking: false, stoppedAt: NOW, now: NOW }).kind).toBe(
      'fixing'
    );
    expect(
      stoppedView({ fix: f, ownerWorking: true, stoppedAt: NOW, now: NOW + 10 * FIX_GRACE_MS }).kind
    ).toBe('fixing');
    expect(
      stoppedView({ fix: f, ownerWorking: false, stoppedAt: NOW, now: NOW + FIX_GRACE_MS }).kind
    ).toBe('ask');
  });

  it('ask and gave-up name the agent to ask', () => {
    expect(stoppedView({ fix: fix('ask'), ownerWorking: true, stoppedAt: NOW, now: NOW })).toEqual({
      kind: 'ask',
      agentId: 'site',
      agentName: 'Site Builder',
      reason: 'a compile error',
    });
    expect(
      stoppedView({ fix: fix('gave-up'), ownerWorking: false, stoppedAt: NOW, now: NOW }).kind
    ).toBe('gave-up');
  });
});

describe('open panes and exits', () => {
  it('a pane names its agent for the folder until it closes', () => {
    const off = registerPreviewPane('/p/site', 'site');
    expect(paneAgentFor('/p/site')).toBe('site');
    // A later pane for the same folder isn't undone by the earlier one closing.
    const later = registerPreviewPane('/p/site', 'other');
    off();
    expect(paneAgentFor('/p/site')).toBe('other');
    later();
    expect(paneAgentFor('/p/site')).toBeNull();
  });

  it('an exit reaches every listener, and a failing one never stops the rest', () => {
    const seen: string[] = [];
    const offA = onDevServerExit(() => {
      throw new Error('boom');
    });
    const offB = onDevServerExit((e) => seen.push(`${e.projectPath}:${e.exitCode}`));
    reportDevServerExit({ projectPath: '/p/site', exitCode: 1, output: 'Failed to compile' });
    offA();
    offB();
    reportDevServerExit({ projectPath: '/p/site', exitCode: 2, output: '' });
    expect(seen).toEqual(['/p/site:1']);
  });
});
