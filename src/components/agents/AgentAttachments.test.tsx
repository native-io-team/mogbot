/**
 * An image an agent shared is a picture, or says why it isn't: never an
 * empty box. (Real chats showed shared screenshots as blank frames.)
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AttachmentImage, IMAGE_UNAVAILABLE, MessageAttachments } from './AgentAttachments';
import type { Agent } from '../../lib/agents';

const agent = {
  id: 'social',
  name: 'Social Posts',
  home: '/h/social',
  status: { state: 'idle', activity: null, since: null },
} as Agent;

const shot = {
  name: 'scheduled-posts.jpg',
  path: 'attachments/m9/scheduled-posts.jpg',
  mime: 'image/jpeg',
  size: 68_000,
};

describe('a shared image', () => {
  it('loads at once from the agent’s attachments, not lazily', () => {
    render(<MessageAttachments agent={agent} attachments={[shot]} side="agent" />);
    const img = screen.getByRole('img', { name: 'scheduled-posts.jpg' });
    expect(img.getAttribute('src')).toContain('attachments/m9/scheduled-posts.jpg');
    // A lazy image inside a `content-visibility: auto` row could never load.
    expect(img.getAttribute('loading')).toBeNull();
  });

  it('says it is not available, with its name, when the file can’t be loaded', () => {
    render(<MessageAttachments agent={agent} attachments={[shot]} side="agent" />);
    fireEvent.error(screen.getByRole('img', { name: 'scheduled-posts.jpg' }));
    const missing = screen.getByRole('img', { name: /scheduled-posts\.jpg: image not available/ });
    expect(missing.textContent).toContain(IMAGE_UNAVAILABLE);
    expect(missing.textContent).toContain('scheduled-posts.jpg');
    // Still a button: tapping it opens the view with Open / Show in Finder.
    expect(screen.getByRole('button', { name: 'View scheduled-posts.jpg' })).toBeTruthy();
  });

  it('tries again when it is asked for a different file', () => {
    const { rerender } = render(<AttachmentImage agent={agent} attachment={shot} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText(IMAGE_UNAVAILABLE)).toBeTruthy();
    rerender(
      <AttachmentImage
        agent={agent}
        attachment={{ ...shot, name: 'post-2.jpg', path: 'attachments/m10/post-2.jpg' }}
      />
    );
    expect(screen.getByRole('img', { name: 'post-2.jpg' })).toBeTruthy();
  });
});
