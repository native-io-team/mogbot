import {
  noticesOf,
  plainActivity,
  readTaskScreen,
  saidOf,
  stepLabel,
  stepsOf,
  terminalFirst,
  isStatusLine,
} from '../src/lib/taskScreen';

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

const ASK = 'Tighten the hero spacing below 640px and keep the CTA above the fold.';

describe('a task screen, read as a conversation', () => {
  it('starts after what the Mac sent, and says its steps and words without the machinery', () => {
    const r = readTaskScreen(CLAUDE, ASK);
    expect(r.asked).toBe(ASK);
    expect(stepsOf(r)).toEqual(['Read Hero.tsx', 'Edited Hero.tsx', 'Took a screenshot']);
    expect(saidOf(r)).toBe(
      'The hero now fits above the fold at 390px. The CTA sits at 612px, inside the first screen.'
    );
    expect(r.parts.some((p) => p.kind === 'typed')).toBe(false);
    const all = JSON.stringify(r.parts);
    for (const chrome of ['esc to interrupt', 'shortcuts', 'shift+tab', '⎿', '╭', 'section']) {
      expect(all).not.toContain(chrome);
    }
  });

  it('a message sent over several lines is found where it wrapped', () => {
    const r = readTaskScreen(
      ['> Tighten the hero spacing below 640px', '  and keep the CTA above the fold.', '⏺ On it.'].join(
        '\n'
      ),
      ASK
    );
    expect(r.asked).toBe(ASK);
    expect(r.parts).toEqual([{ kind: 'said', text: 'On it.' }]);
  });
});

describe('what it was asked is only what the Mac sent', () => {
  it('without it, there is no asked, and nothing above a pointer line is dropped', () => {
    const r = readTaskScreen(
      ['> First ask', '⏺ Done with that.', '', '> Second ask', '⏺ Bash(pnpm test)', '  ⎿  ok'].join(
        '\n'
      )
    );
    expect(r.asked).toBeUndefined();
    expect(r.parts).toEqual([
      { kind: 'typed', text: '> First ask' },
      { kind: 'said', text: 'Done with that.' },
      { kind: 'typed', text: '> Second ask' },
      { kind: 'step', text: 'Ran pnpm test' },
    ]);
  });

  it('a sent text that is no longer on the screen gives no asked, and the whole screen', () => {
    const r = readTaskScreen(['⏺ Earlier words.', '⏺ Bash(ls)'].join('\n'), 'Something else');
    expect(r.asked).toBeUndefined();
    expect(saidOf(r)).toBe('Earlier words.');
  });

  it('never takes tool output, a quote or the Codex placeholder for a message', () => {
    const r = readTaskScreen(
      [
        '› Fix the links',
        '• Ran pnpm build',
        '  └ > site@1.0.0 build',
        '    > astro build',
        '• Built. The quote was:',
        '',
        '› Implement {feature}',
        '',
        '  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit   88% context left',
      ].join('\n')
    );
    expect(r.asked).toBeUndefined();
    const all = JSON.stringify(r);
    expect(all).not.toContain('Implement {feature}');
    expect(all).not.toContain('astro build');
    expect(all).not.toContain('transcript');
    expect(r.parts[0]).toEqual({ kind: 'typed', text: '› Fix the links' });
  });

  it('never takes a numbered option or the empty input box for the message', () => {
    const r = readTaskScreen(
      ['> Make it sticky', '⏺ Update(Header.tsx)', '❯ '].join('\n'),
      'Make it sticky'
    );
    expect(r.asked).toBe('Make it sticky');
    expect(stepsOf(r)).toEqual(['Edited Header.tsx']);
  });
});

describe('errors and interruptions are never hidden', () => {
  it('Claude Code: an API error under a tool call', () => {
    const r = readTaskScreen(
      [
        '> Tighten the hero',
        '⏺ Read(src/Hero.tsx)',
        '  ⎿  Read 84 lines',
        '  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ].join('\n'),
      'Tighten the hero'
    );
    expect(noticesOf(r)).toEqual([
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    ]);
  });

  it('Claude Code: retrying, and an interrupt', () => {
    const r = readTaskScreen(
      [
        '⏺ Update(Hero.tsx)',
        '  ⎿  API Error (529 Overloaded) · Retrying in 4 seconds… (attempt 2/10)',
        '  ⎿  Interrupted · What should Claude do instead?',
        '',
        '╭────────────╮',
        '│ >          │',
        '╰────────────╯',
      ].join('\n')
    );
    expect(noticesOf(r)).toEqual([
      'API Error (529 Overloaded) · Retrying in 4 seconds… (attempt 2/10)',
      'Interrupted · What should Claude do instead?',
    ]);
  });

  it('Claude Code: a failed command and a rejected edit', () => {
    const r = readTaskScreen(
      [
        '⏺ Bash(pnpm test)',
        '  ⎿  Error: Command failed with exit code 1',
        '⏺ Update(a.ts)',
        '  ⎿  User rejected update to a.ts',
      ].join('\n')
    );
    expect(noticesOf(r)).toEqual([
      'Error: Command failed with exit code 1',
      'User rejected update to a.ts',
    ]);
  });

  it('a count of nothing failing is not a notice', () => {
    const r = readTaskScreen('⏺ Bash(pnpm test)\n  ⎿  Tests: 12 passed, 0 failed\n⏺ All green.');
    expect(noticesOf(r)).toEqual([]);
  });

  it("Codex: '■ stream error … retrying' shows; only spinner glyphs are status lines", () => {
    const line = '■ stream error: stream disconnected before completion; retrying 1/5 in 200ms…';
    expect(isStatusLine(line)).toBe(false);
    expect(isStatusLine('✻ Cogitated for 4s')).toBe(true);
    expect(isStatusLine('✶ Wrangling… (3s · ↑ 1.2k tokens)')).toBe(true);
    expect(isStatusLine('→ Next… (2s)')).toBe(false);
    const r = readTaskScreen(
      ['› Fix the links', '• Working (3s • esc to interrupt)', line].join('\n'),
      'Fix the links'
    );
    expect(noticesOf(r)).toEqual([
      'stream error: stream disconnected before completion; retrying 1/5 in 200ms…',
    ]);
  });

  it('Codex: a ⚠ warning shows', () => {
    const r = readTaskScreen('⚠ Heads up, you have less than 10% of your weekly limit left');
    expect(noticesOf(r)).toEqual(['Heads up, you have less than 10% of your weekly limit left']);
  });

  it('a finished task with a notice opens the terminal and does not read as fine', () => {
    const r = readTaskScreen('⏺ Done.\n  ⎿  Interrupted · What should Claude do instead?');
    expect(terminalFirst(r, 'working', false)).toBe(true);
  });
});

describe('prompts are kept whole', () => {
  it('Claude Code, boxed: the diff, the question and every option, borders stripped', () => {
    const r = readTaskScreen(
      [
        '⏺ Update(src/Header.tsx)',
        '',
        '╭──────────────────────────────────────────────╮',
        '│ Edit file                                    │',
        '│ ╭──────────────────────────────────────────╮ │',
        '│ │ src/Header.tsx                           │ │',
        '│ │ 13 -   return <header>                   │ │',
        '│ │ 13 +   return <header className="sticky">│ │',
        '│ ╰──────────────────────────────────────────╯ │',
        '│ Do you want to make this edit to Header.tsx? │',
        '│ ❯ 1. Yes                                     │',
        "│   2. Yes, and don't ask again this session (shift+tab) │",
        '│   3. No, and tell Claude what to do differently (esc) │',
        '╰──────────────────────────────────────────────╯',
      ].join('\n')
    );
    expect(r.prompt).toEqual([
      'Edit file',
      'src/Header.tsx',
      '13 -   return <header>',
      '13 +   return <header className="sticky">',
      'Do you want to make this edit to Header.tsx?',
      '❯ 1. Yes',
      "2. Yes, and don't ask again this session (shift+tab)",
      '3. No, and tell Claude what to do differently (esc)',
    ]);
    expect(stepsOf(r)).toEqual(['Edited Header.tsx']);
    expect(terminalFirst(r, 'working', false)).toBe(true);
  });

  it('Claude Code, ruled: the command and the options', () => {
    const r = readTaskScreen(
      [
        '⏺ I’ll clear the build output.',
        '',
        '⏺ Bash(rm -rf dist)',
        '  ⎿  Running…',
        '',
        '────────────────────────────────────────────────────────',
        ' Bash command',
        '',
        '   rm -rf dist',
        '   Remove the build output',
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        "   2. Yes, and don't ask again for rm commands in /Users/j/site",
        '   3. No, and tell Claude what to do differently (esc)',
      ].join('\n')
    );
    expect(r.prompt).toEqual([
      'Bash command',
      'rm -rf dist',
      'Remove the build output',
      'Do you want to proceed?',
      '❯ 1. Yes',
      "2. Yes, and don't ask again for rm commands in /Users/j/site",
      '3. No, and tell Claude what to do differently (esc)',
    ]);
    expect(saidOf(r)).toBe('I’ll clear the build output.');
    expect(stepsOf(r)).toEqual(['Ran rm -rf dist']);
  });

  it('Codex: the command, the options and how to answer', () => {
    const r = readTaskScreen(
      [
        '• I’ll clear the build output first.',
        '',
        '  Would you like to run the following command?',
        '',
        '  $ rm -rf dist',
        '',
        '› 1. Yes, proceed (y)',
        "  2. Yes, and don't ask again for this command (a)",
        '  3. No, and tell Codex what to do differently (esc)',
        '',
        '  Press enter to confirm or esc to cancel',
      ].join('\n')
    );
    expect(r.prompt).toEqual([
      'Would you like to run the following command?',
      '$ rm -rf dist',
      '› 1. Yes, proceed (y)',
      "2. Yes, and don't ask again for this command (a)",
      '3. No, and tell Codex what to do differently (esc)',
      'Press enter to confirm or esc to cancel',
    ]);
    expect(saidOf(r)).toBe('I’ll clear the build output first.');
  });

  it('Codex, older: a barred prompt with unnumbered choices', () => {
    const r = readTaskScreen(
      ['▌ Allow command?', '▌', '▌ $ pnpm test', '▌', '▌ ▶ Yes   No, provide feedback'].join('\n')
    );
    expect(r.prompt).toEqual(['Allow command?', '$ pnpm test', '▶ Yes   No, provide feedback']);
  });

  it("a question in the agent's own reply is words, not a prompt", () => {
    const r = readTaskScreen(
      ['⏺ I fixed the header. Should I also fix the footer?', '  Would you like that?'].join('\n')
    );
    expect(r.prompt).toBeUndefined();
    expect(saidOf(r)).toBe('I fixed the header. Should I also fix the footer? Would you like that?');
  });
});

describe('when the terminal opens by itself', () => {
  const working = readTaskScreen('⏺ Working on it.');
  it('stays shut only while it is working with words and nothing wrong', () => {
    expect(terminalFirst(working, 'working', false)).toBe(false);
    expect(terminalFirst(working, 'finished', false)).toBe(true);
    expect(terminalFirst(working, 'needs_decision', true)).toBe(true);
    expect(terminalFirst(readTaskScreen('⏺ Bash(ls)'), 'working', false)).toBe(true);
  });
});

describe('labels', () => {
  it('keeps a sentence with brackets as words, not a step', () => {
    expect(stepLabel('Done (all good)')).toBeNull();
    expect(stepLabel('Read(/a/b/c.ts)')).toBe('Read c.ts');
    expect(stepLabel('WebFetch(https://example.com/x)')).toBe('Read example.com');
    expect(stepLabel('mcp__github__create_issue(title: "x")')).toBe('Used create issue');
  });

  it("keeps Codex's own step lines as they are, and its other lines as words", () => {
    const r = readTaskScreen(
      [
        '› Fix the links',
        '• Ran pnpm check-links',
        '• Found 3 broken links in guides',
        '• Working (5s • esc to interrupt)',
      ].join('\n'),
      'Fix the links'
    );
    expect(stepsOf(r)).toEqual(['Ran pnpm check-links']);
    expect(saidOf(r)).toBe('Found 3 broken links in guides');
  });

  it('says the activity without the terminal’s timer', () => {
    expect(plainActivity('Checking the hero at 390px… (12s)')).toBe('Checking the hero at 390px');
    expect(plainActivity('Working')).toBe('Working');
  });
});
