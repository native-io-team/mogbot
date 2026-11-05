/**
 * Dictation: on the phone's own recognizer or not at all, spoken words after
 * what was typed, and never a send. The recognizer is a fake with the native
 * module's shape (expo-speech-recognition), so this runs without a phone.
 */

import { act, renderHook } from '@testing-library/react-native';
import { dictationHint, dictationSupport, joinDictation, useDictation } from '../src/lib/dictation';

type Listener = (e: never) => void;

function fakeRecognizer({ onDevice = true, granted = true } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const fire = (name: string, e: unknown = null) =>
    listeners.get(name)?.forEach((l) => (l as (e: unknown) => void)(e));
  const r = {
    started: [] as Record<string, unknown>[],
    supportsOnDeviceRecognition: () => onDevice,
    isRecognitionAvailable: () => true,
    requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted })),
    start: jest.fn((options: Record<string, unknown>) => {
      r.started.push(options);
      fire('start');
    }),
    stop: jest.fn(() => fire('end')),
    abort: jest.fn(() => fire('end')),
    addListener: (name: string, l: Listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(l);
      return { remove: () => listeners.get(name)!.delete(l) };
    },
    fire,
  };
  return r;
}

type Fake = ReturnType<typeof fakeRecognizer>;

async function setup(r: Fake | null, typed = '') {
  let draft = typed;
  const problems: string[] = [];
  const hook = await renderHook(() =>
    useDictation({
      getDraft: () => draft,
      setDraft: (t) => (draft = t),
      vocabulary: ['Chief of Staff', 'Inbox'],
      onProblem: (p) => problems.push(p),
      recognizer: r as never,
    })
  );
  return { hook, draft: () => draft, problems };
}

describe('dictation', () => {
  it('joins what you say after what you typed', () => {
    expect(joinDictation('', ' hello ')).toBe('hello');
    expect(joinDictation('Tell Inbox', 'to archive')).toBe('Tell Inbox to archive');
    expect(joinDictation('Line ', 'two')).toBe('Line two');
    expect(joinDictation('kept', '  ')).toBe('kept');
  });

  it('is off without the native module (Expo Go), pointing at the keyboard', () => {
    expect(dictationSupport(null)).toBe('no-module');
    expect(dictationHint('no-module')).toMatch(/keyboard/);
  });

  it('stays off rather than send your voice to a server', async () => {
    const r = fakeRecognizer({ onDevice: false });
    expect(dictationSupport(r as never)).toBe('needs-network');
    const { hook } = await setup(r);
    await act(async () => {
      expect(await hook.result.current.start()).toBe(false);
    });
    expect(r.start).not.toHaveBeenCalled();
    expect(dictationHint('needs-network')).toMatch(/never leaves the phone/);
  });

  it('listens on the device, puts words in the draft, and never sends', async () => {
    const r = fakeRecognizer();
    const { hook, draft } = await setup(r, 'Ask Inbox');
    await act(async () => {
      await hook.result.current.start();
    });
    expect(r.started[0]).toMatchObject({
      requiresOnDeviceRecognition: true,
      interimResults: true,
      contextualStrings: ['Chief of Staff', 'Inbox'],
    });
    expect(hook.result.current.phase).toBe('listening');
    await act(() => r.fire('result', { isFinal: false, results: [{ transcript: 'to' }] }));
    expect(draft()).toBe('Ask Inbox to');
    await act(() =>
      r.fire('result', { isFinal: true, results: [{ transcript: 'to archive receipts' }] })
    );
    await act(() => r.fire('result', { isFinal: false, results: [{ transcript: 'today' }] }));
    expect(draft()).toBe('Ask Inbox to archive receipts today');
    await act(() => hook.result.current.stop());
    expect(hook.result.current.phase).toBe('idle');
  });

  it('drops words still on their way once the draft is sent', async () => {
    const r = fakeRecognizer();
    const { hook, draft } = await setup(r);
    await act(async () => {
      await hook.result.current.start();
    });
    await act(() => hook.result.current.cancel());
    await act(() => r.fire('result', { isFinal: true, results: [{ transcript: 'late' }] }));
    expect(draft()).toBe('');
    expect(r.abort).toHaveBeenCalled();
  });

  it('says what it needs when permission is refused', async () => {
    const r = fakeRecognizer({ granted: false });
    const { hook, problems } = await setup(r);
    await act(async () => {
      await hook.result.current.start();
    });
    expect(r.start).not.toHaveBeenCalled();
    expect(problems[0]).toMatch(/Allow them in Settings/);
  });
});
