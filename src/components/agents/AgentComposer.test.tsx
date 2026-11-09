import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentComposer, LiveSecretHint } from './AgentComposer';
import { composerDraft, setComposerDraft } from '../../lib/composerDraft';
import { resetChatRestoreForTests, unsentDraft } from '../../lib/chatRestore';

const dictation = {
  phase: 'idle' as const,
  toggle: () => {},
  cancel: () => {},
  onComposerKeyDown: () => false,
};

function Chat({ id, onSend, renders }: { id: string; onSend: () => void; renders: () => void }) {
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
        busy={false}
        working={false}
        onStop={() => {}}
        onSend={onSend}
        onPickFiles={() => {}}
      />
    </>
  );
}

afterEach(() => {
  setComposerDraft('a1', '');
  setComposerDraft('a2', '');
  resetChatRestoreForTests();
});

describe('the composer owns what is typed', () => {
  it('re-renders itself per key, never the chat around it', () => {
    const renders = vi.fn();
    const onSend = vi.fn();
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
