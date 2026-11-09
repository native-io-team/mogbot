/**
 * The accounts list is read from several places at once (mount, focus, change
 * events, after each change); an older read answering late must not put the
 * old order back over a newer one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { UsageAccount } from '../../lib/agentAccounts';
import { useUsageAccounts } from './useUsageAccounts';

afterEach(() => {
  cleanup();
  clearMocks();
});

const acct = (id: string): UsageAccount => ({
  id,
  engine: 'claude',
  name: id,
  named: true,
  thisMac: id === 'default',
  signedIn: true,
  out: false,
});

describe('useUsageAccounts', () => {
  it('keeps the newest list when an older read answers last', async () => {
    const reads: ((l: UsageAccount[]) => void)[] = [];
    mockIPC(
      (cmd) => {
        if (cmd === 'agents_accounts') return new Promise((r) => reads.push(r));
        return null;
      },
      { shouldMockEvents: true }
    );
    const { result } = renderHook(() => useUsageAccounts());
    await act(async () => {
      await Promise.resolve();
    });
    expect(reads).toHaveLength(1);

    // "Use this one now": the Mac answers with the new order at once.
    await act(async () => {
      await result.current.attempt(() => Promise.resolve([acct('work'), acct('default')]));
    });
    expect(result.current.accounts?.map((a) => a.id)).toEqual(['work', 'default']);

    // The read after the change lands, then the one from mount, late.
    await act(async () => {
      reads[1]([acct('work'), acct('default')]);
      reads[0]([acct('default'), acct('work')]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.accounts?.map((a) => a.id)).toEqual(['work', 'default']);
  });
});
