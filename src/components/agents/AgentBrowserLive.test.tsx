import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentBrowserPane, BrowserLiveCard, BrowserStill } from './AgentBrowserLive';
import { AgentPreviewProvider, useAgentPreviewRequest } from './AgentPreviewContext';
import {
  forgetLastFrames,
  lastFrameOf,
  rememberLastFrame,
  siteOf,
  siteOfStep,
  type LiveBrowserFrame,
} from '../../lib/agentsOwnBrowser';
import type { Agent, TurnWork } from '../../lib/agents';

const T0 = 1_762_290_000_000;

const work = (over: Partial<TurnWork> = {}): TurnWork => ({
  startedAt: T0,
  stepCount: 3,
  fileCount: 0,
  steps: [],
  doing: 'Using its own browser · example.com',
  current: {
    kind: 'web',
    label: 'Using its own browser · example.com',
    startedAt: T0 + 1_000,
  } as TurnWork['current'],
  ownBrowser: true,
  ...over,
});

const agentWith = (w: TurnWork | undefined, state = 'working'): Agent =>
  ({
    id: 'leadgen',
    name: 'Lead Gen',
    home: '/h/leadgen',
    status: { state, work: w },
  }) as unknown as Agent;

const frame = (seq = 1, over: Partial<LiveBrowserFrame> = {}): LiveBrowserFrame => ({
  seq,
  src: 'data:image/jpeg;base64,AAAA',
  width: 640,
  height: 400,
  url: 'https://www.northwind-supply.com/directory',
  title: 'Packaging suppliers',
  ...over,
});

let calls: { cmd: string; args: Record<string, unknown> }[] = [];

/** The Mac: one picture for a new watcher, nothing new after. */
function mac(
  answer: (args: Record<string, unknown>) => unknown = (a) => (a.after ? null : frame())
) {
  calls = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === 'agents_browser_live_frame') return answer(a);
    return null;
  });
}

/** What the pane would show, so a click on the card can be seen to open it. */
function PaneProbe() {
  const req = useAgentPreviewRequest();
  return <output data-testid="pane">{req?.browser ? `browser:${req.agentId}` : 'closed'}</output>;
}

const frameCalls = () => calls.filter((c) => c.cmd === 'agents_browser_live_frame');

beforeEach(() => {
  forgetLastFrames();
  mac();
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe('the live card under the working line', () => {
  it('shows the page live, names its site, and opens the pane', async () => {
    const w = work();
    render(
      <AgentPreviewProvider>
        <BrowserLiveCard agent={agentWith(w)} work={w} />
        <PaneProbe />
      </AgentPreviewProvider>
    );
    // Before the first picture: the step's site, and a stand-in.
    expect(
      screen.getByRole('button', { name: 'Watch Lead Gen on example.com' })
    ).toBeInTheDocument();
    const img = await waitFor(() => {
      const el = document.querySelector('.agent-browser-card img');
      if (!el) throw new Error('no picture yet');
      return el as HTMLImageElement;
    });
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    // The page's own address wins once known, without "www.".
    expect(screen.getByText('northwind-supply.com')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    // The thumbnail size, and the next ask is for the frame after it.
    expect(frameCalls()[0].args).toEqual({ agentId: 'leadgen', after: 0, large: false });
    await waitFor(() => expect(frameCalls().some((c) => c.args.after === 1)).toBe(true));
    // Kept for the reply this turn ends on.
    expect(lastFrameOf('leadgen', T0)?.seq).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /Watch Lead Gen/ }));
    expect(screen.getByTestId('pane')).toHaveTextContent('browser:leadgen');
    // The pane has it now: the card stops its own screencast and says so.
    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: 'agents_browser_live_stop',
        args: { agentId: 'leadgen', large: false },
      })
    );
    expect(screen.getByText('Open beside')).toBeInTheDocument();
  });

  it('stops asking while the window is hidden, and starts again when it is back', async () => {
    const w = work();
    render(
      <AgentPreviewProvider>
        <BrowserLiveCard agent={agentWith(w)} work={w} />
      </AgentPreviewProvider>
    );
    await waitFor(() => expect(frameCalls().length).toBeGreaterThan(0));
    const hidden = { value: 'hidden' };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => hidden.value,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(calls.some((c) => c.cmd === 'agents_browser_live_stop')).toBe(true);
    const asked = frameCalls().length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(frameCalls().length).toBe(asked);
    hidden.value = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(frameCalls().length).toBeGreaterThan(asked));
    // @ts-expect-error -- back to jsdom's own
    delete document.visibilityState;
  });

  it('waits quietly when the Mac has no page to show yet', async () => {
    mac(() => null);
    const w = work();
    render(
      <AgentPreviewProvider>
        <BrowserLiveCard agent={agentWith(w)} work={w} />
      </AgentPreviewProvider>
    );
    await waitFor(() => expect(frameCalls().length).toBe(1));
    expect(document.querySelector('.agent-browser-card img')).toBeNull();
    expect(document.querySelector('.agent-browser-card__screen[data-empty]')).not.toBeNull();
  });
});

describe('the pane beside the chat', () => {
  it('watches larger, shows the address, and offers Open in Chrome', async () => {
    const w = work();
    render(<AgentBrowserPane agent={agentWith(w)} turnStartedAt={T0} onClose={() => undefined} />);
    await waitFor(() => expect(document.querySelector('.agent-browser-pane img')).not.toBeNull());
    expect(frameCalls()[0].args).toEqual({ agentId: 'leadgen', after: 0, large: true });
    expect(screen.getByText('https://www.northwind-supply.com/directory')).toBeInTheDocument();
    expect(screen.getByText('Packaging suppliers')).toBeInTheDocument();
    expect(screen.getByText('View only: Lead Gen won’t see clicks here.')).toBeInTheDocument();
    // No Take control: input isn't wired to the page from here.
    expect(screen.queryByRole('button', { name: /take control/i })).toBeNull();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Open in Chrome' }));
    });
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === 'agents_show_agent_browser')).toBe(true)
    );
    expect(calls).toContainEqual({
      cmd: 'agents_show_agent_browser',
      args: { agentId: 'leadgen', show: true },
    });
  });

  it('once the turn is over, shows its last picture and asks for nothing', () => {
    rememberLastFrame('leadgen', T0, frame(7));
    render(
      <AgentBrowserPane
        agent={agentWith(undefined, 'idle')}
        turnStartedAt={T0}
        onClose={() => undefined}
      />
    );
    expect(document.querySelector('.agent-browser-pane img')).not.toBeNull();
    expect(screen.getByText('Last seen')).toBeInTheDocument();
    expect(screen.getByText(/Lead Gen is done with this page/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Chrome' })).toBeNull();
    expect(frameCalls()).toHaveLength(0);
  });
});

describe('the still a finished turn keeps', () => {
  it('appears only when this session saw the page', () => {
    const w = work({ ownBrowser: undefined, current: undefined });
    const { rerender } = render(<BrowserStill agent={agentWith(undefined, 'idle')} work={w} />);
    expect(document.querySelector('.agent-browser-card--still')).toBeNull();
    rememberLastFrame('leadgen', T0, frame(3));
    rerender(<BrowserStill agent={agentWith(undefined, 'idle')} work={{ ...w }} />);
    expect(document.querySelector('.agent-browser-card--still img')).not.toBeNull();
    expect(screen.getByText('Last seen')).toBeInTheDocument();
    expect(screen.queryByText('Live')).toBeNull();
  });
});

describe('the words and the memory', () => {
  it('names a site from an address or a step', () => {
    expect(siteOf('https://www.example.com/a?b=1')).toBe('example.com');
    expect(siteOf('about:blank')).toBeNull();
    expect(siteOf('not a url')).toBeNull();
    expect(siteOfStep('Using its own browser · shop.example.org')).toBe('shop.example.org');
    expect(siteOfStep('Running the tests')).toBeNull();
  });

  it('keeps only the last few turns’ pictures', () => {
    for (let i = 0; i < 20; i++) rememberLastFrame('a', i, frame(i + 1));
    expect(lastFrameOf('a', 0)).toBeNull();
    expect(lastFrameOf('a', 19)?.seq).toBe(20);
  });
});
