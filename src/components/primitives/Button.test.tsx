import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './Button';
import { TrashIcon } from '@/components/icons';

describe('Button', () => {
  it('gives a danger button a warning icon so it is not told apart by hue alone', () => {
    render(<Button variant="danger">Delete</Button>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.querySelector('.button__icon svg')).not.toBeNull();
    expect(button.className).toContain('button--has-icon');
  });

  it('keeps an icon the caller passed instead of adding a second one', () => {
    render(
      <Button variant="danger" leftIcon={<TrashIcon size={14} data-testid="trash" />}>
        Delete
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.querySelectorAll('.button__icon')).toHaveLength(1);
    expect(screen.getByTestId('trash')).toBeTruthy();
  });

  it('adds no icon to other variants', () => {
    render(<Button variant="primary">Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).querySelector('.button__icon')).toBeNull();
  });
});
