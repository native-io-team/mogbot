import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  FILE_FORMAT_PROBLEM,
  PASTE_FORMAT_PROBLEM,
  PasteProblems,
  pasteProblemInWords,
} from './ImportParts';

describe('a pasted reply that can’t be read', () => {
  const problems = [
    'Block 2 has a trailing comma at line 14 (a comma right before a } or ]).',
    '“Travel”: "is_main" should be true or false, not text.',
  ];

  it('says one plain sentence, and keeps the parser’s lines behind Show details', () => {
    render(<PasteProblems problems={problems} />);
    expect(screen.getByText(PASTE_FORMAT_PROBLEM)).toBeVisible();
    expect(screen.queryByText(/trailing comma/)).toBeNull();
    expect(screen.queryByText(/is_main/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText(/trailing comma at line 14/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('a problem that already says its own fix is the sentence, not "copy the message again"', () => {
    const cut =
      'The JSON stops before it’s complete, so it was probably cut off. Ask the assistant to send that part again.';
    render(<PasteProblems problems={[cut]} />);
    expect(screen.getByText(cut)).toBeVisible();
    expect(screen.queryByText(PASTE_FORMAT_PROBLEM)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show details' })).toBeNull();
  });

  it('a parser line, or a problem with no fix in it, keeps the plain sentence', () => {
    expect(pasteProblemInWords([problems[0]])).toBeNull();
    expect(pasteProblemInWords(['There are no agents in it.'])).toBeNull();
    expect(pasteProblemInWords(problems)).toBeNull();
    expect(
      pasteProblemInWords([
        'There’s no JSON in what you pasted. Paste the assistant’s whole reply, including its ```json block.',
      ])
    ).toMatch(/^There’s no JSON/);
  });
});

describe('an export file or folder that can’t be read', () => {
  it('says one line with the way out, the parser’s lines behind Show details', () => {
    render(
      <PasteProblems
        problems={[
          'export.json isn’t valid JSON at line 3: expected value. Ask the assistant to send it again as valid JSON.',
          '“A”: "is_main" should be true or false, not text.',
        ]}
        fallback={FILE_FORMAT_PROBLEM}
      />
    );
    expect(screen.getByText(FILE_FORMAT_PROBLEM)).toBeVisible();
    expect(screen.queryByText(/is_main/)).toBeNull();
  });

  it('a file problem that says its own fix is the line', () => {
    for (const line of [
      'That file is empty. Export again from the app it came from, or use Paste a reply instead.',
      'That file is over 4 MB, too large to be one export. Pick the folder it came in (each file there is read on its own), or use Paste a reply instead.',
      'That isn’t a readable zip. Export again from the app it came from, or use Paste a reply instead.',
    ]) {
      expect(pasteProblemInWords([line])).toBe(line);
    }
  });
});
