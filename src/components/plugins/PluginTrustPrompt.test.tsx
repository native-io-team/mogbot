import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { ModalProvider, useOpenModal } from '../../contexts/ModalContext';
import { PluginTrustPrompt } from './PluginTrustPrompt';
import type { PluginInfo } from '../../lib/plugins';

function info(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    manifest: {
      id: 'webflow-to-code',
      name: 'Webflow to Code',
      version: '1.0.0',
      description: '',
      slots: ['toolbar'],
      author: '',
      repository: '',
      setup: [],
      min_app_version: '',
      icon: '',
      required_commands: [],
    },
    enabled: true,
    installed_at: 0,
    source_url: 'https://github.com/someone/webflow-to-code',
    is_dev: false,
    local_path: '',
    trust: 'unknown',
    sha256: 'feed',
    source_path: '/Users/me/ShipStudio/site/.shipstudio/plugins/webflow-to-code',
    ...overrides,
  };
}

function Opened({ children }: { children: React.ReactNode }) {
  const open = useOpenModal();
  useEffect(() => open('pluginTrust'), [open]);
  return <>{children}</>;
}

function renderPrompt(pending: PluginInfo[], onAllow = vi.fn(async () => {}), onDecline = vi.fn()) {
  render(
    <ModalProvider>
      <Opened>
        <PluginTrustPrompt pending={pending} onAllow={onAllow} onDecline={onDecline} />
      </Opened>
    </ModalProvider>
  );
  return { onAllow, onDecline };
}

describe('PluginTrustPrompt', () => {
  it('says what wants to load and where its code comes from', () => {
    renderPrompt([info()]);
    expect(
      screen.getByText('This project wants to load the plugin Webflow to Code.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('/Users/me/ShipStudio/site/.shipstudio/plugins/webflow-to-code')
    ).toBeInTheDocument();
    expect(screen.getByText('https://github.com/someone/webflow-to-code')).toBeInTheDocument();
  });

  it('names a changed plugin as changed', () => {
    renderPrompt([info({ trust: 'changed' })]);
    expect(
      screen.getByText('Webflow to Code has changed since you allowed it.')
    ).toBeInTheDocument();
  });

  it('Allow approves the plugin shown', async () => {
    const plugin = info();
    const { onAllow } = renderPrompt([plugin]);
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(onAllow).toHaveBeenCalledWith(plugin));
  });

  it("Don't load declines it and moves on to the next one", () => {
    const first = info();
    const second = info({
      manifest: { ...info().manifest, id: 'other', name: 'Other' },
    });
    const { onDecline } = renderPrompt([first, second]);
    expect(screen.getByText('1 more plugin is waiting.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Don't load" }));
    expect(onDecline).toHaveBeenCalledWith(first);
  });

  it('renders nothing when nothing is waiting', () => {
    renderPrompt([]);
    expect(screen.queryByTestId('plugin-trust-prompt')).not.toBeInTheDocument();
  });
});
