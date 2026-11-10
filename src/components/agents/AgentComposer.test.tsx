import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentComposer, LiveSecretHint } from './AgentComposer';
import { composerDraft, setComposerDraft } from '../../lib/composerDraft';
import { resetChatRestoreForTests, unsentDraft } from '../../lib/chatRestore';
import { QUEUE_HINT_LEARNED_AFTER } from '../../lib/queueHint';

const dictation = {
  phase: 'idle' as const,
  toggle: () => {},
  cancel: () => {},
  onComposerKeyDown: () => false,
};

function Chat({
  id,
  onSend,
  renders,
  unfilled,
  lastSent,
  busy = false,
}: {
  id: string;
  onSend: (now?: boolean) => void;
  renders: () => void;
  unfilled?: string;
  lastSent?: () => string | null;
  busy?: boolean;
}) {
  renders();
  return (
    <>
      <LiveSecretHint agentId={id} agentName="Ops" />
      <AgentComposer
        agentId={id}
        agentName="Ops"
        inputRef={createRef()}
        micRef={createRef()}
        dictation={dictation}
        mentionSet={[]}
        staged={[]}
        onRemoveStaged={() => {}}
        onPaste={() => {}}
        quotes={[]}
        onRemoveQuote={() => {}}
        revising={null}
        onClearRevising={() => {}}
        busy={busy}
        working={busy}
        onStop={() => {}}
        onSend={onSend}
        onPickFiles={() => {}}
        unfilled={unfilled}
        lastSent={lastSent}
      />
    </>
  );
}

afterEach(() => {
  setComposerDraft('a1', '');
  setComposerDraft('a2', '');
  resetChatRestoreForTests();
  localStorage.clear();
});

describe('↑ brings back what you last sent', () => {
  it('fills an empty field with it, and leaves ↑ alone once anything is typed', () => {
    render(
      <Chat id="a1" onSend={() => {}} renders={() => {}} lastSent={() => 'Run the tests again'} />
    );
    const box = screen.getByRole('textbox', { name: 'Message Ops' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box).toHaveValue('Run the tests again');
    fireEvent.change(box, { target: { value: 'Something else' } });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box).toHaveValue('Something else');
  });

  it('does nothing with nothing sent yet, or with a modifier held', () => {
    const { unmount } = render(
      <Chat id="a1" onSend={() => {}} renders={() => {}} lastSent={() => null} />
    );
    const box = screen.getByRole('textbox', { name: 'Message Ops' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box).toHaveValue('');
    unmount();
    render(<Chat id="a1" onSend={() => {}} renders={() => {}} lastSent={() => 'Hi'} />);
    const again = screen.getByRole('textbox', { name: 'Message Ops' });
    fireEvent.keyDown(again, { key: 'ArrowUp', metaKey: true });
    expect(again).toHaveValue('');
  });
});

describe('the composer owns what is typed', () => {
  it('re-renders itself per key, never the chat around it', () => {
    const renders = vi.fn();
    const onSend = vi.fn<(now?: boolean) => void>();
    render(<Chat id="a1" onSend={onSend} renders={renders} />);
    const box = screen.getByRole('textbox', { name: 'Message Ops' });
    for (const text of ['H', 'He', 'Hey']) fireEvent.change(box, { target: { value: text } });
    expect(box).toHaveValue('Hey');
    expect(renders).toHaveBeenCalledTimes(1);
    // Kept per agent, for the next open and the next launch.
    expect(composerDraft('a1')).toBe('Hey');
    expect(unsentDraft('a1')).toBe('Hey');
    expect(composerDraft('a2')).toBe('');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith(false);
  });

  it('opens on the draft kept for that agent, and shows a change made from outside', () => {
    setComposerDraft('a2', 'Half a thought');
    render(<Chat id="a2" onSend={() => {}} renders={() => {}} />);
    const box = screen.getByRole('textbox', { name: 'Message Ops' });
    expect(box).toHaveValue('Half a thought');
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('still offers to keep a key typed into it out of the chat', () => {
    render(<Chat id="a1" onSend={() => {}} renders={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Ops' }), {
      target: { value: 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' },
    });
    expect(screen.getByRole('button', { name: 'Store it securely' })).toBeInTheDocument();
  });
});

describe('a starter’s brief with its blank still empty', () => {
  const brief = 'Every weekday at 8am, brief me. My topics: ';

  it('can’t be sent until something is written in the blank', () => {
    const onSend = vi.fn<(now?: boolean) => void>();
    setComposerDraft('a1', brief);
    render(<Chat id="a1" onSend={onSend} renders={() => {}} unfilled={brief} />);
    const box = screen.getByRole('textbox', { name: 'Message Ops' });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText('Fill in the end, then send')).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: `${brief}AI chips` } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(screen.queryByText('Fill in the end, then send')).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith(false);
  });
});

describe('↵ queues, ⌘↵ sends now, while it works', () => {
  const caption = () => document.querySelector('.agent-composer__queue-hint');

  it('says so under the box only once something is typed, and describes the field', () => {
    render(<Chat id="a1" onSend={() => {}} renders={() => {}} busy />);
    const box = screen.getByRole('textbox', { name: 'Message Ops' });
    expect(caption()).toBeNull();
    expect(box).not.toHaveAttribute('aria-describedby');
    fireEvent.change(box, { target: { value: 'And the 404 page' } });
    expect(caption()).toHaveTextContent('↵ queue·⌘↵ send now');
    expect(box).toHaveAccessibleDescription(
      'Enter queues it for when Ops finishes. Command Enter interrupts Ops and sends it now.'
    );
  });

  it('says nothing while idle, where ↵ just sends', () => {
    render(<Chat id="a1" onSend={() => {}} renders={() => {}} />);
    const box = screen.getByRole('textbox', { name: 'Message Ops' });
    fireEvent.change(box, { target: { value: 'Hi' } });
    expect(caption()).toBeNull();
    expect(box).not.toHaveAttribute('aria-describedby');
  });

  it('keeps ↵ and ⌘↵ as they were, and steps aside once both are used a few times', () => {
    const onSend = vi.fn<(now?: boolean) => void>();
    render(<Chat id="a1" onSend={onSend} renders={() => {}} busy />);
    const box = screen.getByRole('textbox', { name: 'Message Ops' });
    for (let i = 0; i < QUEUE_HINT_LEARNED_AFTER; i++) {
      fireEvent.change(box, { target: { value: 'q' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    }
    expect(onSend.mock.calls.map((c) => c[0])).toEqual(
      Array.from({ length: QUEUE_HINT_LEARNED_AFTER }, () => [false, true]).flat()
    );
    // Learned: nothing visible, the description stays for a screen reader.
    expect(caption()).toHaveAttribute('data-learned');
    expect(caption()).not.toHaveTextContent('send now');
    expect(box).toHaveAccessibleDescription(/Command Enter interrupts Ops/);
  });
});
