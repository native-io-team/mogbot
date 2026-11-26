import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { useGrowingInput } from './AgentComposer';

const LINE = 20;

/**
 * The field as laid out: once wrapped, the words get a row of their own, so
 * a draft just past one line in the narrow field fits one line again.
 */
function Field({ draft }: { draft: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrapped = useGrowingInput(ref, draft);
  return (
    <form data-wrapped={wrapped || undefined}>
      <textarea ref={ref} value={draft} readOnly />
    </form>
  );
}

describe('useGrowingInput', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a draft at the edge of one line settles instead of flipping layouts forever', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      maxHeight: '440px',
      lineHeight: `${LINE}px`,
      paddingTop: '0px',
      paddingBottom: '0px',
    } as CSSStyleDeclaration);
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLTextAreaElement
    ) {
      if (!this.value) return LINE;
      return this.closest('form')?.hasAttribute('data-wrapped') ? LINE : LINE * 2;
    });
    const { container, rerender } = render(<Field draft="" />);
    expect(() => rerender(<Field draft="just long enough to wrap" />)).not.toThrow();
    expect(container.querySelector('form')!.hasAttribute('data-wrapped')).toBe(true);
    // Emptied (sent or cleared): back to one row.
    rerender(<Field draft="" />);
    expect(container.querySelector('form')!.hasAttribute('data-wrapped')).toBe(false);
  });
});
