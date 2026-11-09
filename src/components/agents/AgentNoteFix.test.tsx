import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ModalProvider, useModal } from '../../contexts/ModalContext';
import { NoteLine } from './AgentChatItems';
import type { AgentMessage } from '../../lib/agents';
import { peekSettingsTabOnOpen, takeSettingsSectionRequest } from '../../lib/settings';

const note = (over: Partial<AgentMessage> = {}): AgentMessage => ({
  id: 'n1',
  agentId: 'a1',
  ts: 0,
  kind: 'note',
  text: 'Chrome isn’t reachable through Claude’s extension. Set up Your Chrome once (Settings → Agents → Your Chrome) so this can’t happen again.',
  ...over,
});

function SettingsOpen() {
  const { isOpen } = useModal('settings');
  return <span data-testid="settings-open">{String(isOpen)}</span>;
}

describe('a note that names its fix', () => {
  it('offers the fix as a button that opens Settings → Agents → Your Chrome', () => {
    render(
      <ModalProvider>
        <NoteLine message={note({ fix: 'user_chrome' })} />
        <SettingsOpen />
      </ModalProvider>
    );
    expect(screen.getByText(/Chrome isn’t reachable through Claude’s extension/)).toBeTruthy();
    expect(screen.getByTestId('settings-open').textContent).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Set up Your Chrome' }));
    expect(screen.getByTestId('settings-open').textContent).toBe('true');
    expect(peekSettingsTabOnOpen()).toBe('agents');
    expect(takeSettingsSectionRequest('agent-user-chrome')).toBe(true);
  });

  it('a plain note has no button', () => {
    render(
      <ModalProvider>
        <NoteLine message={note()} />
      </ModalProvider>
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
