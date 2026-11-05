import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentAppsModal } from './AgentAppsModal';

afterEach(() => clearMocks());

describe('AgentAppsModal', () => {
  it('asks you to connect claude.ai’s apps there, and says which agents they reach', async () => {
    mockIPC((cmd) => (cmd === 'agents_apps_list' ? { connected: [], suggestions: [] } : null));
    render(<AgentAppsModal isOpen onClose={() => undefined} />);
    const meta = await screen.findByText(/Connect these on claude\.ai/);
    // An instruction, never a status: nothing is connected yet.
    expect(meta.textContent).not.toMatch(/^Connected/);
    expect(meta.textContent).toMatch(
      /reach Claude Code agents signed in with a claude\.ai account/
    );
  });
});
