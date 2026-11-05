import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { PluginTrustPrompt } from './PluginTrustPrompt';
import type { PluginInfo } from '../../lib/plugins';

const PROJECT = '/Users/me/ShipStudio/site';
const SHA = 'b'.repeat(64);

function info(state: 'new' | 'changed', id = 'vercel', name = 'Vercel'): PluginInfo {
  return {
    manifest: {
      id,
      name,
      version: '1.0.0',
      description: '',
      slots: [],
      author: '',
      repository: '',
      setup: [],
      min_app_version: '',
      icon: '',
      required_commands: [],
    },
    enabled: true,
    installed_at: 0,
    source_url: 'https://github.com/acme/plugin',
    is_dev: false,
    local_path: '',
    trust: { state, sha256: SHA, bundlePath: `${PROJECT}/.shipstudio/plugins/${id}/dist/index.js` },
  };
}

describe('PluginTrustPrompt', () => {
  let calls: { cmd: string; args: Record<string, unknown> }[];

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: args as Record<string, unknown> });
      return null;
    });
  });

  afterEach(() => clearMocks());

  it('names the plugin and where it comes from', () => {
    render(<PluginTrustPrompt projectPath={PROJECT} pending={[info('new')]} onDecided={vi.fn()} />);
    expect(screen.getByText('This project wants to load plugin Vercel')).toBeTruthy();
    expect(screen.getByText(`${PROJECT}/.shipstudio/plugins/vercel/dist/index.js`)).toBeTruthy();
    expect(screen.getByText('https://github.com/acme/plugin')).toBeTruthy();
  });

  it('says when an approved plugin changed', () => {
    render(
      <PluginTrustPrompt projectPath={PROJECT} pending={[info('changed')]} onDecided={vi.fn()} />
    );
    expect(screen.getByText('Plugin Vercel changed since you allowed it')).toBeTruthy();
  });

  it('Allow approves exactly the bundle it showed, then reloads', async () => {
    const onDecided = vi.fn();
    render(
      <PluginTrustPrompt
        projectPath={PROJECT}
        pending={[info('new'), info('new', 'other', 'Other')]}
        onDecided={onDecided}
      />
    );
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByText('Allow'));
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
    expect(calls).toEqual([
      { cmd: 'approve_plugin', args: { projectPath: PROJECT, pluginId: 'vercel', sha256: SHA } },
    ]);
  });

  it("Don't load is remembered for that bundle", async () => {
    const onDecided = vi.fn();
    render(
      <PluginTrustPrompt projectPath={PROJECT} pending={[info('new')]} onDecided={onDecided} />
    );
    fireEvent.click(screen.getByText('Don’t load'));
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
    expect(calls[0].cmd).toBe('decline_plugin');
    expect(calls[0].args.sha256).toBe(SHA);
  });
});
