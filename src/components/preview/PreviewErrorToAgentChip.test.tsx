import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PreviewErrorToAgentChip } from './PreviewErrorToAgentChip';
import type { CommentAgent } from '../../lib/canvasComments';

const shell = (): CommentAgent => ({
  id: 1,
  label: 'Terminal · 1',
  send: vi.fn(),
  isAgent: false,
  isActive: true,
});

describe('PreviewErrorToAgentChip', () => {
  it('shows the exact text and sends only on click, to the agent tab', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const onDismiss = vi.fn();
    const plain = shell();
    const claude: CommentAgent = { id: 2, label: 'Claude Code · 2', send, isAgent: true };
    render(
      <PreviewErrorToAgentChip
        error="TypeError: x is undefined"
        agents={[plain, claude]}
        onDismiss={onDismiss}
      />
    );
    expect(screen.getByText('TypeError: x is undefined')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude Code · 2' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(String(send.mock.calls[0][0])).toContain('TypeError: x is undefined');
    expect(plain.send).not.toHaveBeenCalled();
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
  });

  it('cannot send when only a plain shell is open', () => {
    render(<PreviewErrorToAgentChip error="boom" agents={[shell()]} onDismiss={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Send to agent' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/never sent to a plain terminal/)).toBeTruthy();
  });
});
