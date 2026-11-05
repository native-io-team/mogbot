import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PASTE_FORMAT_PROBLEM, PasteProblems } from './ImportParts';

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
});
