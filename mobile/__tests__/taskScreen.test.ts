import { plainActivity, readTaskScreen, stepLabel } from '../src/lib/taskScreen';

const CLAUDE = [
  '> Tighten the hero spacing below 640px and keep the CTA above the fold.',
  '',
  '⏺ Read(src/components/Hero.tsx)',
  '  ⎿  Read 84 lines',
  '',
  '⏺ Update(src/components/Hero.tsx)',
  '  ⎿  Updated src/components/Hero.tsx with 3 additions and 2 removals',
  '       21 -      <section className="pt-24 pb-20">',
  '       21 +      <section className="pt-6 pb-10 sm:pt-24 sm:pb-20">',
  '',
  '⏺ preview_screenshot (device: phone)',
  '  ⎿  Captured 390×844',
  '',
  '⏺ The hero now fits above the fold at 390px. The CTA sits',
  '  at 612px, inside the first screen.',
  '',
  '✻ Checking the hero at 390px… (12s · esc to interrupt)',
  '',
  '╭──────────────────────────────────────────╮',
  '│ >                                        │',
  '╰──────────────────────────────────────────╯',
  '  ? for shortcuts                ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

describe('a task screen, read as a conversation', () => {
  it('says what it was asked, its steps in words, and what it said, without the machinery', () => {
    const r = readTaskScreen(CLAUDE);
    expect(r.asked).toBe('Tighten the hero spacing below 640px and keep the CTA above the fold.');
    expect(r.steps).toEqual(['Read Hero.tsx', 'Edited Hero.tsx', 'Took a screenshot']);
    expect(r.said).toBe(
      'The hero now fits above the fold at 390px. The CTA sits at 612px, inside the first screen.'
    );
    const all = JSON.stringify(r);
    for (const chrome of ['esc to interrupt', 'shortcuts', 'shift+tab', '⎿', '╭', 'section']) {
      expect(all).not.toContain(chrome);
    }
  });

  it('reads only the newest exchange', () => {
    const r = readTaskScreen(
      ['> First ask', '⏺ Done with that.', '', '> Second ask', '⏺ Bash(pnpm test)', '  ⎿  ok'].join(
        '\n'
      )
    );
    expect(r.asked).toBe('Second ask');
    expect(r.steps).toEqual(['Ran pnpm test']);
    expect(r.said).toBe('');
  });

  it('never takes a numbered option or the empty input box for the message', () => {
    const r = readTaskScreen(
      [
        '> Make it sticky',
        '⏺ Update(Header.tsx)',
        '  Do you want to make this edit?',
        '❯ 1. Yes',
        '  2. No',
        '❯ ',
      ].join('\n')
    );
    expect(r.asked).toBe('Make it sticky');
  });

  it("keeps Codex's own step lines as they are, and its other lines as words", () => {
    const r = readTaskScreen(
      [
        '› Fix the links',
        '• Ran pnpm check-links',
        '• Found 3 broken links in guides',
        '• Working (5s • esc to interrupt)',
      ].join('\n')
    );
    expect(r.steps).toEqual(['Ran pnpm check-links']);
    expect(r.said).toBe('Found 3 broken links in guides');
  });

  it('keeps a sentence with brackets as words, not a step', () => {
    expect(stepLabel('Done (all good)')).toBeNull();
    expect(stepLabel('Read(/a/b/c.ts)')).toBe('Read c.ts');
    expect(stepLabel('WebFetch(https://example.com/x)')).toBe('Read example.com');
    expect(stepLabel('mcp__github__create_issue(title: "x")')).toBe('Used create issue');
  });

  it('says the activity without the terminal’s timer', () => {
    expect(plainActivity('Checking the hero at 390px… (12s)')).toBe('Checking the hero at 390px');
    expect(plainActivity('Working')).toBe('Working');
  });
});
