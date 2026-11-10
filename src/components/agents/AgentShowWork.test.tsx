/**
 * Agents showing their work: the before/after compare on a result card, the
 * preview opening by itself for visual work, links to this Mac's servers,
 * and the full-size viewer as a gallery of the whole chat.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { clearMocks } from '@tauri-apps/api/mocks';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { ReactNode } from 'react';
import { ResultCardView, resetAutoOpened } from './AgentResult';
import { AgentBubble } from './AgentChatItems';
import { AgentGalleryProvider } from './AgentGallery';
import { MessageAttachments } from './AgentAttachments';
import { AgentPreviewProvider, useAgentPreviewRequest } from './AgentPreviewContext';
import type { Agent, AgentMessage, Attachment, ResultCard } from '../../lib/agents';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

const agent = {
  id: 'des',
  name: 'Design',
  home: '/h/des',
  status: { state: 'idle', activity: null, since: null },
} as Agent;

const png = (msg: string, name: string): Attachment => ({
  name,
  path: `attachments/${msg}/${name}`,
  mime: 'image/png',
  size: 9,
});

const VISUAL: ResultCard = {
  id: 'res-v',
  version: 1,
  title: 'New homepage',
  summary: 'Hero, pricing and footer redone.',
  project: '/p/harbor-cafe',
  items: [
    { kind: 'file', file: png('v', 'home-b.png'), role: 'before', page: 'Home' },
    { kind: 'file', file: png('v', 'home-a.png'), role: 'after', page: 'Home' },
    { kind: 'file', file: png('v', 'menu-b.png'), role: 'before', page: 'Menu' },
    {
      kind: 'file',
      file: png('v', 'menu-a.png'),
      role: 'after',
      page: 'Menu',
      label: 'Menu, two columns',
    },
    { kind: 'file', file: png('v', 'contact-a.png'), role: 'after', page: 'Contact' },
  ],
};

const resultMessage = (card: ResultCard, id = 'v'): AgentMessage => ({
  id,
  agentId: 'des',
  ts: 2,
  kind: 'agent',
  text: card.summary,
  result: card,
});

/** Shows what the preview context was asked to open. */
function Opened() {
  const request = useAgentPreviewRequest();
  return (
    <output data-testid="opened">
      {request ? `${request.messageId}:${request.link ?? '-'}:${request.test ? 't' : ''}` : ''}
    </output>
  );
}

const withPreview = (node: ReactNode) => (
  <AgentPreviewProvider>
    {node}
    <Opened />
  </AgentPreviewProvider>
);

afterEach(() => {
  clearMocks();
  resetAutoOpened();
  vi.mocked(openUrl).mockClear();
});

describe('the compare on a result card', () => {
  it('switches pages, captions with the agent’s words, and shows a one-sided page alone', () => {
    render(<ResultCardView message={resultMessage(VISUAL)} card={VISUAL} agent={agent} newest />);
    const compare = screen.getByLabelText('Before and after');
    const pages = within(compare).getByRole('group', { name: 'Page' });
    expect(
      within(pages)
        .getAllByRole('button')
        .map((r) => r.textContent)
    ).toEqual(['Home', 'Menu', 'Contact']);
    expect(within(compare).getByText('Before')).toBeTruthy();
    fireEvent.click(within(pages).getByRole('button', { name: 'Menu' }));
    expect(within(compare).getByText('Menu, two columns')).toBeTruthy();
    fireEvent.click(within(pages).getByRole('button', { name: 'Contact' }));
    expect(within(compare).queryByText('Before')).toBeNull();
    expect(within(compare).getByText('After')).toBeTruthy();
    // One picture: no slider to offer.
    expect(within(compare).queryByRole('group', { name: 'Compare as' })).toBeNull();
    // Compared pictures aren't listed again.
    expect(screen.queryByRole('list', { name: 'What it made' })).toBeNull();
  });

  it('turns into a slider the keyboard can move', () => {
    render(<ResultCardView message={resultMessage(VISUAL)} card={VISUAL} agent={agent} newest />);
    fireEvent.click(screen.getByRole('button', { name: 'Slider' }));
    const range = screen.getByRole('slider', { name: 'Compare Before and After' });
    expect((range as HTMLInputElement).value).toBe('50');
    fireEvent.change(range, { target: { value: '20' } });
    expect((range as HTMLInputElement).value).toBe('20');
    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('offers Preview and Test it for visual work with a project, and marks a checkpoint', () => {
    const checkpoint = { ...VISUAL, checkpoint: true };
    render(
      withPreview(
        <ResultCardView
          message={resultMessage(checkpoint)}
          card={checkpoint}
          agent={agent}
          newest
        />
      )
    );
    expect(screen.getByText('Partway through')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test it' }));
    expect(screen.getByTestId('opened').textContent).toBe('v:-:t');
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    expect(screen.getByTestId('opened').textContent).toBe('v:-:');
  });
});

describe('the preview opening by itself', () => {
  it('opens once for a visual card that just arrived, never for history or again', () => {
    const { rerender, unmount } = render(
      withPreview(
        <ResultCardView message={resultMessage(VISUAL)} card={VISUAL} agent={agent} newest />
      )
    );
    expect(screen.getByTestId('opened').textContent).toBe('');
    unmount();
    const view = render(
      withPreview(
        <ResultCardView
          message={resultMessage(VISUAL)}
          card={VISUAL}
          agent={agent}
          newest
          arrived
        />
      )
    );
    expect(screen.getByTestId('opened').textContent).toBe('v:-:');
    view.unmount();
    // Its next version arriving doesn't open it again.
    render(
      withPreview(
        <ResultCardView
          message={resultMessage({ ...VISUAL, version: 2 }, 'v2')}
          card={{ ...VISUAL, version: 2 }}
          agent={agent}
          newest
          arrived
        />
      )
    );
    expect(screen.getByTestId('opened').textContent).toBe('');
    void rerender;
  });

  it('leaves a card without pictures or a project alone', () => {
    const plain = { ...VISUAL, id: 'res-p', items: [] };
    render(
      withPreview(
        <ResultCardView message={resultMessage(plain)} card={plain} agent={agent} newest arrived />
      )
    );
    expect(screen.getByTestId('opened').textContent).toBe('');
  });
});

describe('links to servers on this Mac', () => {
  const reply: AgentMessage = {
    id: 'm1',
    agentId: 'des',
    ts: 3,
    kind: 'agent',
    text: 'Both are up.',
    localLinks: [
      {
        url: 'http://localhost:3401/',
        label: 'after',
        port: 3401,
        path: '/w/harbor-cafe-copy',
        project: '/p/harbor-cafe',
        copy: true,
      },
      { url: 'http://localhost:9999/', label: 'Old build', port: 9999 },
    ],
  };

  it('a known server offers Preview of that link; an unknown one is a chip that opens here', async () => {
    render(withPreview(<AgentBubble message={reply} agent={agent} />));
    const list = screen.getByRole('list', { name: 'Running on this Mac' });
    const [known, unknown] = within(list).getAllByRole('listitem');
    expect(within(known).getByText('A copy of harbor-cafe')).toBeTruthy();
    fireEvent.click(within(known).getByRole('button', { name: 'Preview' }));
    expect(screen.getByTestId('opened').textContent).toBe('m1:0:');
    expect(within(unknown).queryByRole('button', { name: 'Preview' })).toBeNull();
    expect(within(unknown).getByText('Running on this Mac · localhost:9999')).toBeTruthy();
    fireEvent.click(within(unknown).getByRole('button', { name: 'Open' }));
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('http://localhost:9999/'));
  });
});

describe('the gallery', () => {
  const first: AgentMessage = {
    id: 'm0',
    agentId: 'des',
    ts: 1,
    kind: 'user',
    text: 'Like this',
    attachments: [png('m0', 'ref.png')],
  };
  const messages = [first, resultMessage(VISUAL)];

  it('opens at the picture pressed and steps through the whole chat with keys and buttons', () => {
    render(
      <AgentGalleryProvider messages={messages} agentOf={() => agent}>
        <ResultCardView message={messages[1]} card={VISUAL} agent={agent} newest />
      </AgentGalleryProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /View After: home-a.png/ }));
    // ref.png, home-b, home-a: the third of six.
    expect(screen.getByText('3 of 6')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText('Home · After')).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowRight' });
    });
    expect(screen.getByText('4 of 6')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }));
    expect(screen.getByText('1 of 6')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous picture' })).toHaveProperty(
      'disabled',
      true
    );
  });

  it('turns a page on a sideways trackpad swipe', () => {
    render(
      <AgentGalleryProvider messages={messages} agentOf={() => agent}>
        <MessageAttachments agent={agent} attachments={first.attachments!} />
      </AgentGalleryProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'View ref.png' }));
    expect(screen.getByText('1 of 6')).toBeTruthy();
    const stage = document.querySelector('.agent-lightbox__stage')!;
    fireEvent.wheel(stage, { deltaX: 30, deltaY: 0 });
    expect(screen.getByText('1 of 6')).toBeTruthy();
    fireEvent.wheel(stage, { deltaX: 40, deltaY: 0 });
    expect(screen.getByText('2 of 6')).toBeTruthy();
    // Momentum right after doesn't turn another.
    fireEvent.wheel(stage, { deltaX: 200, deltaY: 0 });
    expect(screen.getByText('2 of 6')).toBeTruthy();
  });

  it('outside a chat, opens over what it was given', () => {
    render(
      <MessageAttachments agent={agent} attachments={[png('x', 'a.png'), png('x', 'b.png')]} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'View b.png' }));
    expect(screen.getByText('2 of 2')).toBeTruthy();
  });
});
