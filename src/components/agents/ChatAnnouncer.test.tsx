import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatAnnouncer } from './ChatAnnouncer';
import { announcementFor, ANNOUNCE_MAX_CHARS } from '../../lib/chatAnnouncer';
import type { AgentMessage } from '../../lib/agents';

const msg = (id: string, kind: AgentMessage['kind'], text: string): AgentMessage => ({
  id,
  agentId: 'a1',
  ts: 1,
  kind,
  text,
});

describe('ChatAnnouncer', () => {
  it('stays quiet for the history the chat opened with', () => {
    render(
      <ChatAnnouncer chatId="a1" agentName="Finance" messages={[msg('1', 'agent', 'Old reply')]} />
    );
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('says a reply that arrives while open, once, and not your own messages', () => {
    const first = [msg('1', 'agent', 'Old reply')];
    const { rerender } = render(<ChatAnnouncer chatId="a1" agentName="Finance" messages={first} />);
    rerender(
      <ChatAnnouncer
        chatId="a1"
        agentName="Finance"
        messages={[...first, msg('2', 'user', 'Thanks')]}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('');
    rerender(
      <ChatAnnouncer
        chatId="a1"
        agentName="Finance"
        messages={[...first, msg('2', 'user', 'Thanks'), msg('3', 'agent', '**Done.** Sent it')]}
      />
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Finance: Done. Sent it');
  });

  it('switching chats does not read the new chat’s history', () => {
    const { rerender } = render(
      <ChatAnnouncer chatId="a1" agentName="Finance" messages={[msg('1', 'agent', 'x')]} />
    );
    rerender(
      <ChatAnnouncer chatId="a2" agentName="Social" messages={[msg('9', 'agent', 'History')]} />
    );
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});

describe('announcementFor', () => {
  it('cuts long replies', () => {
    const line = announcementFor(msg('1', 'agent', 'word '.repeat(100)), 'Chief')!;
    expect(line.length).toBeLessThanOrEqual('Chief: '.length + ANNOUNCE_MAX_CHARS + 1);
    expect(line.endsWith('…')).toBe(true);
  });

  it('names a pending approval and skips an answered one', () => {
    const ask = {
      ...msg('1', 'approval', ''),
      approval: { requestId: 'r', title: 'Push to main', detail: '', status: 'pending' as const },
    };
    expect(announcementFor(ask, 'Chief')).toBe('Chief is asking: Push to main');
    expect(
      announcementFor({ ...ask, approval: { ...ask.approval, status: 'allowed' } }, 'Chief')
    ).toBeNull();
  });

  it('keeps quiet notes quiet', () => {
    expect(announcementFor(msg('1', 'note', 'Allowed automatically'), 'Chief')).toBeNull();
  });
});
