import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictationEvent, DictationStart } from '../../lib/dictation';

let emit: (event: DictationEvent) => void = () => {};
const start = vi.fn<(vocabulary: string[]) => Promise<DictationStart>>();
const stop = vi.fn((_session: number) => Promise.resolve());
const cancel = vi.fn((_session: number) => Promise.resolve());
const learn = vi.fn((_dictated: string, _sent: string) => Promise.resolve<string[]>([]));

vi.mock('../../lib/dictation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/dictation')>()),
  startDictation: (vocabulary: string[]) => start(vocabulary),
  stopDictation: (s: number) => stop(s),
  cancelDictation: (s: number) => cancel(s),
  learnFromDictation: (d: string, t: string) => learn(d, t),
  onDictationEvent: (handler: (event: DictationEvent) => void) => {
    emit = handler;
    return Promise.resolve(() => {});
  },
}));

import { useDictation } from './useDictation';

function setup(initial = 'Hi') {
  let draft = initial;
  const setDraft = vi.fn((text: string) => {
    draft = text;
  });
  const hook = renderHook(() =>
    useDictation({
      getDraft: () => draft,
      setDraft,
      getVocabulary: () => Promise.resolve(['Finance']),
      meterRef: { current: null },
      enabled: true,
    })
  );
  return {
    hook,
    draft: () => draft,
    type: (text: string) => {
      draft = text;
    },
  };
}

describe('useDictation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    start.mockResolvedValue({ status: 'listening', session: 7 });
  });

  it('writes partials after the existing draft and keeps the final text on stop', async () => {
    const { hook, draft } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(start).toHaveBeenCalledWith(['Finance']);
    expect(hook.result.current.phase).toBe('listening');

    act(() => emit({ kind: 'partial', session: 7, text: 'call' }));
    expect(draft()).toBe('Hi call');
    act(() => emit({ kind: 'partial', session: 99, text: 'stale' }));
    expect(draft()).toBe('Hi call');

    act(() => hook.result.current.toggle());
    expect(stop).toHaveBeenCalledWith(7);
    expect(hook.result.current.phase).toBe('finishing');
    act(() => emit({ kind: 'final', session: 7, text: 'call Finance' }));
    act(() => emit({ kind: 'ended', session: 7, cancelled: false }));
    expect(draft()).toBe('Hi call Finance');
    expect(hook.result.current.phase).toBe('idle');
  });

  it('keeps appending across segments until the user stops', async () => {
    const { hook, draft } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => emit({ kind: 'final', session: 7, text: 'First part.' }));
    expect(hook.result.current.phase).toBe('listening');
    act(() => emit({ kind: 'partial', session: 7, text: 'and more' }));
    expect(draft()).toBe('Hi First part. and more');
    act(() => emit({ kind: 'final', session: 7, text: 'And more.' }));
    expect(draft()).toBe('Hi First part. And more.');

    // Cancel still restores what was typed, not the last segment.
    act(() => hook.result.current.cancel());
    expect(draft()).toBe('Hi');
  });

  it('cancel puts the typed draft back', async () => {
    const { hook, draft } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => emit({ kind: 'partial', session: 7, text: 'oops' }));
    act(() => hook.result.current.cancel());
    expect(cancel).toHaveBeenCalledWith(7);
    expect(draft()).toBe('Hi');
    expect(hook.result.current.phase).toBe('idle');
  });

  it('Enter while listening finishes the dictation and sends nothing', async () => {
    const { hook, draft } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => emit({ kind: 'partial', session: 7, text: 'ship it' }));
    const preventDefault = vi.fn();
    let handled = false;
    act(() => {
      handled = hook.result.current.onComposerKeyDown({
        key: 'Enter',
        code: 'Enter',
        preventDefault,
      } as unknown as Parameters<typeof hook.result.current.onComposerKeyDown>[0]);
    });
    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith(7);
    expect(hook.result.current.phase).toBe('finishing');
    expect(draft()).toBe('Hi ship it');
  });

  it('Enter with a send stops, waits for the tidied words, then sends', async () => {
    const { hook, draft } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => emit({ kind: 'partial', session: 7, text: 'tell mogbert' }));
    const send = vi.fn(() => draft());
    act(() => {
      hook.result.current.onComposerKeyDown(
        { key: 'Enter', code: 'Enter', preventDefault: () => {} } as unknown as Parameters<
          typeof hook.result.current.onComposerKeyDown
        >[0],
        send
      );
    });
    expect(stop).toHaveBeenCalledWith(7);
    act(() => emit({ kind: 'final', session: 7, text: 'tell mogbert' }));
    act(() => emit({ kind: 'improving', session: 7 }));
    expect(hook.result.current.phase).toBe('tidying');
    expect(send).not.toHaveBeenCalled();
    act(() =>
      emit({
        kind: 'improved',
        session: 7,
        text: 'Tell Mogbot.',
        raw: 'Tell Mogbert.',
        tidied: true,
      })
    );
    act(() => emit({ kind: 'ended', session: 7, cancelled: false }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.results[0].value).toBe('Hi Tell Mogbot.');
  });

  it('the tidied words replace the live ones, and Undo puts them back', async () => {
    const { hook, draft } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => emit({ kind: 'final', session: 7, text: 'ask labiva' }));
    act(() => hook.result.current.toggle());
    act(() => emit({ kind: 'improving', session: 7 }));
    act(() =>
      emit({ kind: 'improved', session: 7, text: 'Ask Lobeva.', raw: 'Ask Labiva.', tidied: true })
    );
    act(() => emit({ kind: 'ended', session: 7, cancelled: false }));
    expect(draft()).toBe('Hi Ask Lobeva.');
    expect(hook.result.current.undo).not.toBeNull();
    act(() => hook.result.current.undo?.());
    expect(draft()).toBe('Hi ask labiva');
    expect(hook.result.current.undo).toBeNull();
  });

  it('never writes the tidied words over what you typed meanwhile', async () => {
    const { hook, draft, type } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => emit({ kind: 'final', session: 7, text: 'ship it' }));
    act(() => hook.result.current.toggle());
    act(() => emit({ kind: 'improving', session: 7 }));
    type('Something else entirely');
    act(() =>
      emit({ kind: 'improved', session: 7, text: 'Ship it.', raw: 'Ship it.', tidied: false })
    );
    act(() => emit({ kind: 'ended', session: 7, cancelled: false }));
    expect(draft()).toBe('Something else entirely');
    expect(hook.result.current.undo).toBeNull();
  });

  it('Esc while tidying throws the dictation away', async () => {
    const { hook, draft } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => emit({ kind: 'final', session: 7, text: 'nope' }));
    act(() => hook.result.current.toggle());
    act(() => emit({ kind: 'improving', session: 7 }));
    act(() => hook.result.current.cancel());
    expect(cancel).toHaveBeenCalledWith(7);
    expect(draft()).toBe('Hi');
    expect(hook.result.current.phase).toBe('idle');
  });

  it('gives the field back if the stop never reaches the Mac', async () => {
    stop.mockRejectedValueOnce(new Error('gone'));
    const { hook, draft } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => emit({ kind: 'partial', session: 7, text: 'kept' }));
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(hook.result.current.phase).toBe('idle');
    expect(draft()).toBe('Hi kept');
  });

  it('reports a denied permission instead of listening', async () => {
    start.mockResolvedValue({ status: 'blocked', reason: 'microphone' });
    const { hook } = setup();
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(hook.result.current.blocked).toBe('microphone');
    expect(hook.result.current.phase).toBe('idle');
  });

  it('learns from a dictated message only when you changed it before sending', async () => {
    const { hook } = setup('');
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => hook.result.current.toggle());
    act(() => emit({ kind: 'final', session: 7, text: 'ask mog about' }));
    act(() => emit({ kind: 'ended', session: 7, cancelled: false }));
    act(() => hook.result.current.noteSent('ask Mogbot'));
    expect(learn).toHaveBeenCalledWith('ask mog about', 'ask Mogbot');
    // Once per dictation: a later typed message teaches nothing.
    act(() => hook.result.current.noteSent('something else'));
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it('sent as dictated teaches nothing', async () => {
    const { hook } = setup('');
    await act(async () => {
      hook.result.current.toggle();
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => hook.result.current.toggle());
    act(() => emit({ kind: 'final', session: 7, text: 'ship it' }));
    act(() => emit({ kind: 'ended', session: 7, cancelled: false }));
    act(() => hook.result.current.noteSent('ship it'));
    expect(learn).not.toHaveBeenCalled();
  });
});
