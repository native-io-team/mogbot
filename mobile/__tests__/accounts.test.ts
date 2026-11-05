import { accountLines } from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';

describe('usage accounts, on the phone', () => {
  it('reads what a Mac really serves for agents.accounts, worded as the desk words it', () => {
    // The Mac's own serde output (companion/fixtures.rs), before Work's reset.
    const lines = accountLines(real.agentsAccounts, 1_762_290_000_000);
    // Claude Code has two accounts, in order; Codex has only this Mac's, so nothing to show.
    expect(lines.map((l) => l.label)).toEqual(['Claude Code 1. This Mac', 'Claude Code 2. Work']);
    expect(lines[0]).toMatchObject({ detail: 'Signed in', out: false });
    expect(lines[1].out).toBe(true);
    expect(lines[1].detail).toMatch(/^Out of usage until /);
  });

  it('never invents a reset it was not told', () => {
    const lines = accountLines([
      {
        id: 'default',
        engine: 'codex',
        name: 'This Mac',
        thisMac: true,
        signedIn: true,
        out: false,
      },
      {
        id: 'c1',
        engine: 'codex',
        name: 'Plus',
        thisMac: false,
        signedIn: true,
        limit: { at: 1 },
        out: true,
      },
    ]);
    expect(lines[1].detail).toBe('Out of usage · reset time not reported');
  });
});
