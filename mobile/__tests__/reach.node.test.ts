import type { TeamSetupLater } from '@shipstudio/companion-protocol';
import {
  alsoForLine,
  checkLine,
  openRows,
  reachedRows,
  receipt,
  residueLine,
} from '../src/lib/teamSetup';

// A fictional team's rows.
const row = (key: string, extra: Partial<TeamSetupLater>): TeamSetupLater =>
  ({
    key,
    service: key,
    title: key,
    agents: ['Glazes'],
    agentIds: ['glazes'],
    keyOnly: false,
    state: 'open',
    ...extra,
  }) as TeamSetupLater;

describe('the reach check, in words', () => {
  it('reads like the Mac’s progress line', () => {
    expect(checkLine({ running: true, total: 14, checked: [], browser: true })).toBe(
      'Checking 14 services…'
    );
    expect(
      checkLine({
        running: true,
        total: 1,
        checked: [{ title: 'Figma', reached: true }],
        browser: false,
      })
    ).toBe('Checking 1 service… Figma ✓');
    expect(
      checkLine({
        running: false,
        total: 2,
        checked: [
          { title: 'Figma', reached: true },
          { title: 'Kiln log', reached: false },
        ],
        browser: true,
      })
    ).toBe('Checked 2 services. Figma ✓ Kiln log –');
  });

  it('says what is left plainly, never as an alarm', () => {
    expect(residueLine(0)).toBe('Your team is ready.');
    expect(residueLine(1)).toBe('Your team is ready. 1 thing I couldn’t reach on this computer:');
    expect(residueLine(3)).toBe('Your team is ready. 3 things I couldn’t reach on this computer:');
  });

  it('splits rows into the residue and receipts', () => {
    const rows = [
      row('figma', { state: 'reachable', via: 'your browser, signed in on www.figma.com' }),
      row('linkedin', {}),
      row('notion', { state: 'not_needed' }),
    ];
    expect(openRows(rows).map((r) => r.key)).toEqual(['linkedin']);
    const reached = reachedRows(rows);
    expect(reached.map(receipt)).toEqual(['figma: your browser, signed in on www.figma.com']);
  });

  it('names who else a sign-in card is for', () => {
    expect(alsoForLine(undefined)).toBeNull();
    expect(alsoForLine([])).toBeNull();
    expect(alsoForLine(['Glazes', 'Bouquets'])).toBe('Also for Glazes, Bouquets');
  });
});
