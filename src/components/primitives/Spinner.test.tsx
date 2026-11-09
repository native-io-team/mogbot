import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Spinner } from './Spinner';

describe('Spinner', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is phrasing content, so a status line in a <p> can hold one', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <p>
        <Spinner size="sm" /> Checking…
      </p>
    );
    const spinner = screen.getByRole('status', { name: 'Loading' });
    expect(spinner.tagName).toBe('SPAN');
    expect(spinner.className).toBe('ss-spinner ss-spinner--sm');
    // React warns "<p> cannot contain a nested <div>" for the old element.
    expect(error).not.toHaveBeenCalled();
  });
});
