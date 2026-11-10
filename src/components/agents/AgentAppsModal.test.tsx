import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentAppsModal } from './AgentAppsModal';
import type { AppConnections } from '../../lib/agentApps';

afterEach(() => {
  cleanup();
  clearMocks();
});

const APPS = [
  {
    service: 'linear',
    title: 'Linear',
    read: 'Read issues and projects',
    write: 'Create and update issues',
    host: 'mcp.linear.app',
  },
  {
    service: 'vercel',
    title: 'Vercel',
    read: 'Read projects, deployments and logs',
    write: 'Change projects and deploy',
    host: 'mcp.vercel.com',
  },
];

const AGENTS = [
  { id: 'chief', name: 'Chief', isMain: true },
  { id: 'ops', name: 'Ops', isMain: false },
];

function backend(
  ours: Partial<AppConnections>,
  claudeApps: { name: string; target: string; status: string; source: string }[] = []
) {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'agents_app_connections')
        return { apps: APPS, connections: [], flows: [], ...ours };
      if (cmd === 'agents_apps_list') return { connected: claudeApps };
      return null;
    },
    { shouldMockEvents: true }
  );
  return calls;
}

describe('AgentAppsModal', () => {
  it('connects our own apps here, and says claude.ai’s reach only Claude Code agents', async () => {
    backend({});
    render(<AgentAppsModal isOpen onClose={() => undefined} agents={AGENTS} />);
    expect(await screen.findByRole('button', { name: 'Connect Vercel' })).toBeTruthy();
    const meta = await screen.findByText(/Connect these on claude\.ai/);
    expect(meta.textContent).toMatch(/reach agents on Claude Code/);
    // No raw Claude Code terminal to sign in from.
    expect(screen.queryByText(/Type \/mcp/)).toBeNull();
  });

  it('asks which agents can use it, ticking the one it was opened for, and signs in for exactly those', async () => {
    const calls = backend({});
    render(<AgentAppsModal isOpen onClose={() => undefined} agents={AGENTS} forAgentId="ops" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Vercel' }));
    const row = document.querySelector('[data-service="vercel"]') as HTMLElement;
    expect(within(row).getByText('Which agents can use it?')).toBeTruthy();
    expect(within(row).getByLabelText('Ops')).toBeChecked();
    expect(within(row).getByLabelText('Chief')).not.toBeChecked();
    fireEvent.click(within(row).getByRole('button', { name: 'Sign in to Vercel' }));
    await screen.findByRole('button', { name: 'Connect Vercel' });
    const connect = calls.find((c) => c.cmd === 'agents_app_connect');
    expect(connect?.args).toEqual({
      service: 'vercel',
      grants: [{ agentId: 'ops', access: 'read' }],
      again: null,
    });
  });

  it('opened from ⌘K, starts with the Chief ticked, never the whole team', async () => {
    backend({});
    render(<AgentAppsModal isOpen onClose={() => undefined} agents={AGENTS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Linear' }));
    expect(screen.getByLabelText('Chief')).toBeChecked();
    expect(screen.getByLabelText('Ops')).not.toBeChecked();
  });

  it('while it signs in, says so like a login card, with Open again, Copy link and Stop', async () => {
    backend({
      flows: [
        {
          service: 'vercel',
          flow: {
            state: 'waiting',
            option: 'oauth',
            message: 'Vercel’s sign-in opened in your browser.',
            startedAt: Date.now(),
            url: 'https://vercel.com/oauth/authorize?x=1',
            openedAt: Date.now(),
          },
        },
      ],
    });
    render(<AgentAppsModal isOpen onClose={() => undefined} agents={AGENTS} />);
    expect(await screen.findByText(/Vercel’s sign-in opened in your browser/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Vercel' })).toBeNull();
  });

  it('a connection says which account and who can use it', async () => {
    backend({
      connections: [
        {
          id: 'c1',
          service: 'vercel',
          title: 'Vercel',
          account: 'sam@acme.com',
          kind: { type: 'oauth', serverUrl: 'https://mcp.vercel.com' },
          serverKey: 'vercel',
          createdAt: 0,
          grants: [{ agentId: 'chief', access: 'read', grantedAt: 0 }],
        },
      ],
      flows: [
        { service: 'vercel', connected: { connectionId: 'c1', line: 'Connected as sam@acme.com' } },
      ],
    });
    render(<AgentAppsModal isOpen onClose={() => undefined} agents={AGENTS} />);
    expect(await screen.findByText('Connected as sam@acme.com')).toBeTruthy();
    expect(screen.getByText(/Chief can read/)).toBeTruthy();
    // Connected, so it isn't offered again.
    expect(screen.queryByRole('button', { name: 'Connect Vercel' })).toBeNull();
  });

  it('a Claude Code server we connect ourselves is never signed in through /mcp', async () => {
    backend({}, [
      { name: 'vercel', target: 'https://mcp.vercel.com', status: 'needs_auth', source: 'user' },
      {
        name: 'webflow',
        target: 'https://mcp.webflow.com/mcp',
        status: 'needs_auth',
        source: 'user',
      },
    ]);
    render(<AgentAppsModal isOpen onClose={() => undefined} agents={AGENTS} />);
    expect(
      await screen.findByText('Connect it above to use it on Claude Code and Codex alike')
    ).toBeTruthy();
    // Only the one we can't connect ourselves keeps Claude Code's own sign-in.
    expect(screen.getAllByRole('button', { name: 'Sign in…' })).toHaveLength(1);
    expect(screen.getByText(/Only agents on Claude Code use these/)).toBeTruthy();
  });
});
