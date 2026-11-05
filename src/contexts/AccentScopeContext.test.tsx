import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AccentScope } from './AccentScopeContext';
import { ModalFrame } from '../components/primitives/ModalFrame';

describe('AccentScope', () => {
  it('reaches a modal portalled out of the scoped element', () => {
    render(
      <AccentScope color="red">
        <ModalFrame isOpen onClose={() => undefined} title="Edit agent">
          <p>body</p>
        </ModalFrame>
      </AccentScope>
    );
    const overlay = screen.getByRole('dialog').closest('.modal-frame-overlay') as HTMLElement;
    expect(overlay.getAttribute('data-accent-scope')).toBe('red');
    expect(overlay.style.getPropertyValue('--accent-user')).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('leaves a modal outside any scope on the app accent', () => {
    render(
      <ModalFrame isOpen onClose={() => undefined} title="Settings">
        <p>body</p>
      </ModalFrame>
    );
    const overlay = screen.getByRole('dialog').closest('.modal-frame-overlay') as HTMLElement;
    expect(overlay.hasAttribute('data-accent-scope')).toBe(false);
  });
});
