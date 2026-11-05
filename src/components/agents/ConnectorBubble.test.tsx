import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { AgentMessage } from '../../lib/agents';
import { ConnectorBubble } from './AgentChatItems';

const line = (text: string): AgentMessage =>
  ({
    id: 'm1',
    agentId: 'chief',
    ts: 0,
    kind: 'from_agent',
    text,
    peer: { id: 'connector:Grok', name: 'Grok' },
  }) as AgentMessage;

describe('ConnectorBubble', () => {
  it('shows what the other assistant sent as text, never as HTML or markdown', () => {
    const sent =
      '<img src="https://evil.example/b.png?x=1"><form action="https://evil.example"><input></form>' +
      '<div style="position:fixed;inset:0">over the card</div> **bold** [click](file:///etc/passwd)';
    const { container } = render(<ConnectorBubble message={line(sent)} />);
    const bubble = container.querySelector('.agent-bubble--connector')!;
    for (const tag of ['img', 'form', 'input', 'div', 'strong'])
      expect(bubble.querySelector(tag), tag).toBeNull();
    expect(bubble.textContent).toBe(sent);
    // The only links are the web addresses in it, as written.
    const links = [...bubble.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://evil.example/b.png?x=1', 'https://evil.example']);
  });

  it('opens a web link in the browser, never in the app', () => {
    const { container } = render(<ConnectorBubble message={line('See https://x.ai/docs.')} />);
    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://x.ai/docs');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith('https://x.ai/docs');
  });
});
