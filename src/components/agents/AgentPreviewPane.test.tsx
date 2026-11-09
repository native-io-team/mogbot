/**
 * The preview beside the chat: opening on a card's project (started through
 * the window's own dev-server owner), its calm states, the frame and its
 * toolbar, Test it, the live steps, and closing back to the chat. Fictional
 * project and agent throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PreviewRun, PreviewTarget, AgentPreviewServer } from '../../lib/agentPreview';
import type { Agent } from '../../lib/agents';

const api = vi.hoisted(() => ({
  previewTarget: vi.fn(),
  previewTestState: vi.fn(),
  startPreviewTest: vi.fn(),
  stopPreviewTest: vi.fn(),
  attachPreviewPane: vi.fn(),
  handlers: [] as ((run: PreviewRun) => void)[],
}));
vi.mock('../../lib/agentPreview', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentPreview')>()),
  previewTarget: api.previewTarget,
  previewTestState: api.previewTestState,
  startPreviewTest: api.startPreviewTest,
  stopPreviewTest: api.stopPreviewTest,
  attachPreviewPane: api.attachPreviewPane,
  onPreviewTest: (h: (run: PreviewRun) => void) => {
    api.handlers.push(h);
    return Promise.resolve(() => undefined);
  },
}));
const fixApi = vi.hoisted(() => ({
  previewFixState: vi.fn(),
  askToFixPreview: vi.fn(),
  handlers: [] as (() => void)[],
}));
vi.mock('../../lib/agentPreviewFix', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentPreviewFix')>()),
  previewFixState: fixApi.previewFixState,
  askToFixPreview: fixApi.askToFixPreview,
  onPreviewFix: (h: () => void) => {
    fixApi.handlers.push(h);
    return Promise.resolve(() => undefined);
  },
}));
vi.mock('../../lib/window', () => ({
  findAndReservePort: vi.fn((_path: string, port: number) => Promise.resolve(port + 1)),
  getWindowLabel: () => 'main',
}));
const conn = vi.hoisted(() => ({
  serverReady: true,
  hasError: false,
  currentUrl: 'http://localhost:51234/pricing',
  baseUrl: 'http://localhost:51234',
  currentLocation: '/pricing',
  currentPage: '/pricing',
  reloadToken: 0,
  filteredPages: [{ route: '/' }, { route: '/pricing' }],
  handlePageSelect: vi.fn(),
  handleRefresh: vi.fn(),
  handleRetry: vi.fn(),
  handleIframeLoad: vi.fn(),
  setIframePath: vi.fn(),
}));
vi.mock('../../hooks/usePreviewConnection', () => ({ usePreviewConnection: () => conn }));
const bridge = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useAgentBridge', () => ({ useAgentBridge: bridge }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/ToastContext', async (orig) => ({
  ...(await orig<typeof import('../../contexts/ToastContext')>()),
  useOptionalToast: () => ({ showToast: toast }),
}));

import { AgentPreviewPane } from './AgentPreviewPane';
import { devServerConsentStore } from '../../lib/devServerConsent';
import { paneAgentFor, type PreviewFix } from '../../lib/agentPreviewFix';

const agent = {
  id: 'site',
  name: 'Site Builder',
  home: '/h/site',
  status: { state: 'idle', activity: null, since: null },
} as Agent;

const TARGET: PreviewTarget = {
  agentId: 'site',
  messageId: 'm1',
  path: '/p/.worktrees/harbor-bakery/site-1',
  project: '/p/harbor-bakery',
  copy: true,
  port: 4210,
  running: false,
  title: 'New hero section',
};

type Status = ReturnType<AgentPreviewServer['status']>;

function server(status: Status = { status: 'not-running', address: null }) {
  return {
    status: vi.fn(() => status),
    // Still starting: a real server is tracked as starting until it spawns.
    start: vi.fn(() => new Promise<'nextjs'>(() => undefined)),
    needsInstall: vi.fn(() => null as { packageManager: string } | null),
    projectType: vi.fn(() => 'nextjs' as const),
    version: 0,
  } satisfies AgentPreviewServer;
}

const request = { agentId: 'site', messageId: 'm1', n: 1 };

beforeEach(() => {
  api.previewTarget.mockResolvedValue(TARGET);
  api.previewTestState.mockResolvedValue(null);
  api.startPreviewTest.mockResolvedValue({});
  api.stopPreviewTest.mockResolvedValue(true);
  api.attachPreviewPane.mockResolvedValue(undefined);
  fixApi.previewFixState.mockResolvedValue(null);
});

afterEach(() => {
  api.handlers.length = 0;
  fixApi.handlers.length = 0;
  vi.clearAllMocks();
  devServerConsentStore.clear(TARGET.path);
});

function run(state: PreviewRun['state'], steps: PreviewRun['steps'] = []): PreviewRun {
  return {
    id: 'run-1',
    agentId: 'site',
    messageId: 'm1',
    path: TARGET.path,
    project: TARGET.project,
    copy: true,
    title: TARGET.title,
    startedAt: 1,
    state,
    steps,
  };
}

describe('opening the preview', () => {
  it('starts the copy on its own port and says so calmly meanwhile', async () => {
    const s = server();
    render(<AgentPreviewPane agent={agent} request={request} server={s} onClose={vi.fn()} />);
    expect(await screen.findByText('Starting harbor-bakery…')).toBeTruthy();
    await waitFor(() =>
      expect(s.start).toHaveBeenCalledWith(TARGET.path, 'harbor-bakery', TARGET.port! + 1)
    );
    expect(screen.getByText('A copy of harbor-bakery')).toBeTruthy();
    expect(screen.getByText('New hero section')).toBeTruthy();
    // Nothing to test until the site is up.
    expect(screen.getByRole('button', { name: 'Test it' })).toHaveProperty('disabled', true);
  });

  it('a server already up is shown as it is, never started twice', async () => {
    const s = server({ status: 'ready', address: 'localhost:4311' });
    render(<AgentPreviewPane agent={agent} request={request} server={s} onClose={vi.fn()} />);
    expect(await screen.findByTitle('Preview of harbor-bakery')).toBeTruthy();
    expect(s.start).not.toHaveBeenCalled();
    // The frame answers the bridge as the pane, not the workspace.
    expect(bridge).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'pane', projectPath: TARGET.path })
    );
  });

  it('the frame has its toolbar: Back, the address, Reload and a width', async () => {
    const s = server({ status: 'ready', address: 'localhost:4311' });
    render(<AgentPreviewPane agent={agent} request={request} server={s} onClose={vi.fn()} />);
    const address = await screen.findByLabelText('Address');
    expect(address).toHaveProperty('value', '/pricing');
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(conn.handleRefresh).toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Width' })).toBeTruthy();
    // Paths on this site only: another host is refused, not loaded.
    fireEvent.change(address, { target: { value: 'https://elsewhere.example.com/' } });
    fireEvent.keyDown(address, { key: 'Enter' });
    expect(conn.handlePageSelect).not.toHaveBeenCalled();
    fireEvent.change(address, { target: { value: '/signup' } });
    fireEvent.keyDown(address, { key: 'Enter' });
    expect(conn.handlePageSelect).toHaveBeenCalledWith('/signup');
  });

  it('missing dependencies are said as such, with the workspace one click away', async () => {
    const s = server();
    s.needsInstall.mockReturnValue({ packageManager: 'pnpm' });
    const open = vi.fn();
    render(
      <AgentPreviewPane
        agent={agent}
        request={request}
        server={s}
        onClose={vi.fn()}
        onOpenInWorkspace={open}
      />
    );
    expect(await screen.findByText(/needs its dependencies installed first/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open in workspace' })[1]);
    expect(open).toHaveBeenCalledWith(TARGET.path);
  });

  it('a folder whose start ran and left nothing running has no preview here', async () => {
    const s = server();
    s.start.mockImplementation(() => Promise.resolve('nextjs' as const));
    render(<AgentPreviewPane agent={agent} request={request} server={s} onClose={vi.fn()} />);
    expect(await screen.findByText('harbor-bakery has no web preview to show here.')).toBeTruthy();
  });

  it("a card that can't be previewed says why", async () => {
    api.previewTarget.mockRejectedValue({
      type: 'Other',
      message: 'The copy isn’t there any more.',
    });
    render(
      <AgentPreviewPane agent={agent} request={request} server={server()} onClose={vi.fn()} />
    );
    expect(await screen.findByText('The copy isn’t there any more.')).toBeTruthy();
  });
});

describe('Test it', () => {
  it('asks the agent, then shows each step live beside the frame', async () => {
    const s = server({ status: 'ready', address: 'localhost:4311' });
    render(<AgentPreviewPane agent={agent} request={request} server={s} onClose={vi.fn()} />);
    await screen.findByTitle('Preview of harbor-bakery');
    fireEvent.click(screen.getByRole('button', { name: 'Test it' }));
    await waitFor(() => expect(api.startPreviewTest).toHaveBeenCalledWith('site', 'm1'));
    act(() => {
      for (const h of api.handlers) {
        h(
          run('running', [
            { kind: 'open', label: 'Opened /pricing', ok: true, ts: 1 },
            { kind: 'click', label: 'Couldn’t click “Sign up”', ok: false, ts: 2 },
          ])
        );
      }
    });
    expect(screen.getByText('Opened /pricing')).toBeTruthy();
    expect(screen.getByText('Couldn’t click “Sign up”')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop test' })).toBeTruthy();
    act(() => {
      for (const h of api.handlers) h({ ...run('reported'), outcome: 'broken' });
    });
    expect(screen.getByText('Found something broken')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test again' })).toBeTruthy();
  });

  it('Test it pressed on the card starts once the site is up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = server({ status: 'ready', address: 'localhost:4311' });
    render(
      <AgentPreviewPane
        agent={agent}
        request={{ ...request, test: true }}
        server={s}
        onClose={vi.fn()}
      />
    );
    await screen.findByTitle('Preview of harbor-bakery');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(api.startPreviewTest).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("a busy agent can't be asked yet", async () => {
    const busy = { ...agent, status: { state: 'working', activity: null, since: 1 } } as Agent;
    render(
      <AgentPreviewPane
        agent={busy}
        request={request}
        server={server({ status: 'ready', address: 'localhost:4311' })}
        onClose={vi.fn()}
      />
    );
    await screen.findByTitle('Preview of harbor-bakery');
    expect(screen.getByRole('button', { name: 'Test it' })).toHaveProperty('disabled', true);
  });

  it('a run in another folder is not this pane’s', async () => {
    api.previewTestState.mockResolvedValue({ ...run('running'), path: '/p/other-site' });
    render(
      <AgentPreviewPane
        agent={agent}
        request={request}
        server={server({ status: 'ready', address: 'localhost:4311' })}
        onClose={vi.fn()}
      />
    );
    await screen.findByTitle('Preview of harbor-bakery');
    expect(screen.queryByText('Starting the test…')).toBeNull();
  });
});

describe('a site that stopped by itself', () => {
  const STOPPED = { status: 'stopped', address: 'localhost:4311' } as const;
  const fix = (phase: PreviewFix['phase'], at = Date.now()): PreviewFix => ({
    path: TARGET.path,
    agentId: 'site',
    agentName: 'Site Builder',
    phase,
    reason: 'a compile error',
    at,
  });
  const open = vi.fn();
  const pane = (a: Agent = agent, s = server(STOPPED)) =>
    render(
      <AgentPreviewPane
        agent={a}
        request={request}
        server={s}
        onClose={vi.fn()}
        onOpenInWorkspace={open}
      />
    );

  it('shows the agent fixing it while its turn runs, the workspace a quiet link', async () => {
    fixApi.previewFixState.mockResolvedValue(fix('fixing'));
    const busy = { ...agent, status: { state: 'working', activity: null, since: 1 } } as Agent;
    pane(busy);
    expect(await screen.findByText('Site Builder is fixing it…')).toBeTruthy();
    expect(screen.getByText('The site stopped: a compile error.')).toBeTruthy();
    expect(screen.queryByText(/The workspace shows why/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Ask Site Builder/ })).toBeNull();
    const links = screen.getAllByRole('button', { name: 'Open in workspace' });
    fireEvent.click(links[links.length - 1]);
    expect(open).toHaveBeenCalledWith(TARGET.path);
  });

  it('a fix that ended with the site still down offers to ask', async () => {
    fixApi.previewFixState.mockResolvedValue(fix('fixing', Date.now() - 60_000));
    pane();
    expect(await screen.findByRole('button', { name: 'Ask Site Builder to fix it' })).toBeTruthy();
  });

  it('no wake fired: Ask <agent> to fix it, which asks the backend', async () => {
    fixApi.previewFixState.mockResolvedValue(fix('ask'));
    fixApi.askToFixPreview.mockResolvedValue(fix('fixing'));
    pane();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Site Builder to fix it' }));
    await waitFor(() => expect(fixApi.askToFixPreview).toHaveBeenCalledWith('site', TARGET.path));
    expect(await screen.findByText('Site Builder is fixing it…')).toBeTruthy();
  });

  it('after two fixes that didn’t hold it says so and offers to ask again', async () => {
    fixApi.previewFixState.mockResolvedValue(fix('gave-up'));
    pane();
    expect(await screen.findByText('The site keeps stopping: a compile error.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask Site Builder again' })).toBeTruthy();
  });

  it('an event from the backend is read again for this folder', async () => {
    pane();
    await waitFor(() => expect(fixApi.handlers.length).toBeGreaterThan(0));
    fixApi.previewFixState.mockResolvedValue(fix('fixing'));
    act(() => {
      for (const h of fixApi.handlers) h();
    });
    expect(await screen.findByText('Site Builder is fixing it…')).toBeTruthy();
  });

  it('with no agent owning it, the workspace line stays', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    pane();
    // A beat to hear who owns it, without a call to action meanwhile. Under
    // a loaded machine the real clock can pass the beat before the first
    // look, so either wording counts here; the exact one is checked below.
    expect(await screen.findByText(/^The site stopped running\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ask / })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(
      await screen.findByText(
        'The site stopped running. The workspace shows why and can start it again.'
      )
    ).toBeTruthy();
    vi.useRealTimers();
  });

  it('the frame comes back once the server is up again', async () => {
    fixApi.previewFixState.mockResolvedValue(fix('fixing'));
    const s = server(STOPPED);
    const { rerender } = pane(agent, s);
    await screen.findByText('Site Builder is fixing it…');
    s.status.mockReturnValue({ status: 'ready', address: 'localhost:4311' });
    rerender(
      <AgentPreviewPane
        agent={agent}
        request={request}
        server={{ ...s, version: 1 }}
        onClose={vi.fn()}
        onOpenInWorkspace={open}
      />
    );
    expect(await screen.findByTitle('Preview of harbor-bakery')).toBeTruthy();
  });

  it('the pane says whose preview this folder is while it is open', async () => {
    const { unmount } = pane();
    await waitFor(() => expect(paneAgentFor(TARGET.path)).toBe('site'));
    unmount();
    expect(paneAgentFor(TARGET.path)).toBeNull();
  });
});

describe('closing', () => {
  it('goes back to the chat, and a test still going is stopped', async () => {
    api.previewTestState.mockResolvedValue(run('running'));
    const onClose = vi.fn();
    render(
      <AgentPreviewPane
        agent={agent}
        request={request}
        server={server({ status: 'ready', address: 'localhost:4311' })}
        onClose={onClose}
      />
    );
    expect(await screen.findByText('Starting the test…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close the preview' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.stopPreviewTest).toHaveBeenCalledWith('site');
  });

  it('closing with no test going stops nothing', async () => {
    const onClose = vi.fn();
    render(
      <AgentPreviewPane agent={agent} request={request} server={server()} onClose={onClose} />
    );
    await screen.findByText('Starting harbor-bakery…');
    fireEvent.click(screen.getByRole('button', { name: 'Close the preview' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.stopPreviewTest).not.toHaveBeenCalled();
  });
});
