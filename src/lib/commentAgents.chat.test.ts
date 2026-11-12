import { describe, expect, it, vi } from 'vitest';
import { chatAgentTarget } from './commentAgents';
import { composerDraft, setComposerDraft } from './composerDraft';
import { pickErrorAgent } from './previewErrorToAgent';

describe('chatAgentTarget', () => {
  it('is the error target and drafts into the chat without sending', async () => {
    setComposerDraft('agent-1', '');
    const setHidden = vi.fn();
    const target = chatAgentTarget('agent-1', 'Site Builder', setHidden);
    expect(pickErrorAgent([target])).toBe(target);
    await target.send('My dev server is returning an error');
    expect(composerDraft('agent-1')).toBe('My dev server is returning an error');
    expect(setHidden).toHaveBeenCalledWith(false);
  });

  it('keeps what was already typed', async () => {
    setComposerDraft('agent-2', 'half a thought');
    await chatAgentTarget('agent-2', 'X', () => undefined).send('the error');
    expect(composerDraft('agent-2')).toBe('half a thought\n\nthe error');
  });
});
