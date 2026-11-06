/**
 * A file an agent shares with its text (`share_file` `text`): the whole
 * text, as a normal reply, above the image. Asked for "full text then image,
 * post by post", an agent once sent only labels; the text it now sends must
 * show uncut, in the bubble Copy reads from.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentBubble } from './AgentChatItems';
import type { Agent, AgentMessage } from '../../lib/agents';

const agent = {
  id: 'social',
  name: 'Social Posts',
  home: '/h/social',
  status: { state: 'idle', activity: null, since: null },
} as Agent;

const post =
  'Fresh sourdough, out of the oven at 7 every morning this week. Come early: the first ' +
  'loaves always go by 8, and the seeded rye goes even faster than that.';

const message: AgentMessage = {
  id: 'p1',
  agentId: 'social',
  ts: Date.now(),
  kind: 'agent',
  text: `1 of 6 · Fri 10am\n\n${post}\n\n**#bakery** #sourdough`,
  attachments: [
    { name: 'post-1.png', path: 'attachments/p1/post-1.png', mime: 'image/png', size: 10 },
  ],
};

describe('a shared file with its text', () => {
  it('shows the whole text in the reply bubble, above the image', () => {
    const { container } = render(<AgentBubble message={message} agent={agent} />);
    const bubble = container.querySelector('.agent-bubble--agent');
    expect(bubble).not.toBeNull();
    expect(bubble!.textContent).toContain(post);
    expect(bubble!.textContent).toContain('1 of 6 · Fri 10am');
    // Markdown, as any reply.
    expect(bubble!.querySelector('strong')?.textContent).toBe('#bakery');
    const image = screen.getByRole('img', { name: 'post-1.png' });
    expect(bubble!.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
