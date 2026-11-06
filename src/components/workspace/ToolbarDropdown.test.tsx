import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_CODE } from '../../lib/agent';
import { ToolbarDropdown } from './ToolbarDropdown';

describe('ToolbarDropdown', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 900,
      y: 712,
      left: 900,
      top: 712,
      right: 1020,
      bottom: 742,
      width: 120,
      height: 30,
      toJSON: () => ({}),
    });
  });

  it('opens upward from the bottom terminal footer', () => {
    render(
      <ToolbarDropdown
        agent={CLAUDE_CODE}
        autoAcceptMode={false}
        onNotificationSettings={vi.fn()}
        onSkills={vi.fn()}
        onMcp={vi.fn()}
        onAutoAcceptToggle={vi.fn()}
        onHelp={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /agent settings/i }));

    expect(screen.getByRole('menu')).toHaveStyle({
      top: 'auto',
      bottom: `${window.innerHeight - 712 + 6}px`,
    });
  });
});
