/**
 * Dictation: on the phone's own recognizer when it can be, words streaming
 * into the draft after what was typed, Stop keeps them to edit, Send keeps
 * exactly what's on screen and stops at once, × puts the draft back, and
 * never a send of its own. The state machine is walked on its own (idle → starting
 * → listening → stopping → idle, and every way out), then the hook against a
 * fake recognizer with the native module's shape (expo-speech-recognition).
 */

import { act, renderHook } from '@testing-library/react-native';
import {
  AUTO_STOP_SILENCE_MS,
  DICTATION_IDLE,
  NOTHING_HEARD_MS,
  dictationDisplay,
  dictationHint,
  dictationReducer,
  dictationSupport,
  draftText,
  fallsBackToServer,
  joinDictation,
  listeningNote,
  problemCopy,
  problemFromError,
  silenceStops,
  stablePrefix,
  useDictation,
  type DictationEvent,
  type DictationState,
} from '../src/lib/dictation';

type Listener = (e: never) => void;

function fakeRecognizer({
  onDevice = true,
  granted = true,
  available = true,
  // The phone's model isn't there: on-device starts, then fails, as on the simulator.
  onDeviceFails = false,
} = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const fire = (name: string, e: unknown = null) =>
    listeners.get(name)?.forEach((l) => (l as (e: unknown) => void)(e));
  const r = {
    started: [] as Record<string, unknown>[],
    supportsOnDeviceRecognition: () => onDevice,
    isRecognitionAvailable: () => available,
    requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted })),
    start: jest.fn((options: Record<string, unknown>) => {
      r.started.push(options);
      fire('start');
      if (onDeviceFails && options.requiresOnDeviceRecognition) {
        fire('error', { error: 'audio-capture', message: 'Failed to initialize recognizer' });
        fire('end');
      }
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

async function setup(r: Fake | null, typed = '', clock = { t: 1000 }) {
  let draft = typed;
  const levels: number[] = [];
  const hook = await renderHook(() =>
    useDictation({
      getDraft: () => draft,
      setDraft: (t) => (draft = t),
      vocabulary: ['Chief of Staff', 'Inbox'],
      onLevel: (l) => levels.push(l),
      recognizer: r as never,
      now: () => clock.t,
    })
  );
  return { hook, draft: () => draft, levels, clock };
}

const run = (events: DictationEvent[], from: DictationState = DICTATION_IDLE) =>
  events.reduce(dictationReducer, from);

describe('the state machine', () => {
  it('goes idle → starting → listening → stopping → idle, keeping what it heard', () => {
    let s = run([{ type: 'request', draft: 'Ask Inbox' }]);
    expect(s.phase).toBe('starting');
    s = run([{ type: 'began' }], s);
    expect(s.phase).toBe('listening');
    s = run([{ type: 'result', transcript: 'to archive', isFinal: false }], s);
    expect(draftText(s)).toBe('Ask Inbox to archive');
    s = run([{ type: 'stop' }], s);
    expect(s.phase).toBe('stopping');
    // The last words still arrive while it stops.
    s = run([{ type: 'result', transcript: 'to archive receipts.', isFinal: true }], s);
    s = run([{ type: 'end' }], s);
    expect(s).toMatchObject({ phase: 'idle', outcome: 'done', problem: null });
    expect(draftText(s)).toBe('Ask Inbox to archive receipts.');
  });

  it('puts the draft back on ×, whatever it had heard', () => {
    const s = run([
      { type: 'request', draft: 'Typed' },
      { type: 'began' },
      { type: 'result', transcript: 'spoken words', isFinal: true },
      { type: 'result', transcript: 'more', isFinal: false },
      { type: 'cancel' },
    ]);
    expect(s).toMatchObject({ phase: 'idle', outcome: 'cancelled' });
    expect(draftText(s)).toBe('Typed');
    // And the recognizer's own end after the abort changes nothing.
    expect(run([{ type: 'end' }, { type: 'result', transcript: 'x', isFinal: true }], s)).toBe(s);
  });

  it('drops what is on its way once the draft is sent, and leaves the draft alone', () => {
    const s = run([
      { type: 'request', draft: '' },
      { type: 'began' },
      { type: 'result', transcript: 'hi', isFinal: false },
      { type: 'drop' },
    ]);
    expect(s).toMatchObject({ phase: 'idle', outcome: 'sent' });
    expect(run([{ type: 'result', transcript: 'late', isFinal: true }], s)).toBe(s);
  });

  it('on Send keeps exactly the words on screen, the partial too, and takes nothing after', () => {
    const s = run([
      { type: 'request', draft: 'Typed' },
      { type: 'began' },
      { type: 'result', transcript: 'and said', isFinal: true },
      { type: 'result', transcript: 'this too', isFinal: false },
      { type: 'send' },
    ]);
    expect(s).toMatchObject({ phase: 'idle', outcome: 'sent', problem: null });
    expect(draftText(s)).toBe('Typed and said this too');
    // The recognizer's last words after the abort change nothing.
    expect(
      run(
        [
          { type: 'result', transcript: 'late', isFinal: true },
          { type: 'error', code: 'aborted' },
          { type: 'end' },
        ],
        s
      )
    ).toBe(s);
    // Send does nothing when nothing is listening.
    expect(run([{ type: 'send' }])).toBe(DICTATION_IDLE);
  });

  it('treats the silence after speech as Stop: the words stay to edit, nothing is sent', () => {
    const s = run([
      { type: 'request', draft: '' },
      { type: 'began' },
      { type: 'result', transcript: 'draft the email', isFinal: false },
      // What the silence timer applies.
      { type: 'stop' },
      { type: 'end' },
    ]);
    expect(s).toMatchObject({ phase: 'idle', outcome: 'done' });
    expect(draftText(s)).toBe('draft the email');
  });

  it('ends on an error with a problem, keeping the words that were on screen', () => {
    const s = run([
      { type: 'request', draft: '' },
      { type: 'began' },
      { type: 'result', transcript: 'half a', isFinal: false },
      { type: 'error', code: 'network' },
    ]);
    expect(s).toMatchObject({ phase: 'idle', outcome: 'error', problem: 'network' });
    expect(draftText(s)).toBe('half a');
  });

  it('ignores an abort’s own error, and silence after speech', () => {
    const listening = run([
      { type: 'request', draft: '' },
      { type: 'began' },
      { type: 'result', transcript: 'yes', isFinal: false },
    ]);
    expect(run([{ type: 'error', code: 'aborted' }], listening)).toBe(listening);
    expect(run([{ type: 'error', code: 'no-speech' }], listening)).toBe(listening);
  });

  it('says it caught nothing when it heard nothing', () => {
    const s = run([
      { type: 'request', draft: 'x' },
      { type: 'began' },
      { type: 'stop' },
      { type: 'end' },
    ]);
    expect(s).toMatchObject({ phase: 'idle', outcome: 'done', problem: 'nothing-heard' });
    expect(draftText(s)).toBe('x');
  });

  it('refuses without permission, and a second tap while it listens does nothing', () => {
    const refused = run([
      { type: 'request', draft: '' },
      { type: 'refused', problem: 'permission' },
    ]);
    expect(refused).toMatchObject({ phase: 'idle', problem: 'permission' });
    const listening = run([{ type: 'request', draft: 'a' }, { type: 'began' }]);
    expect(run([{ type: 'request', draft: 'b' }], listening)).toBe(listening);
    // A new start clears the last problem.
    expect(run([{ type: 'request', draft: '' }], refused).problem).toBeNull();
  });

  it('can be told Stop before the recognizer has started', () => {
    const s = run([{ type: 'request', draft: '' }, { type: 'stop' }]);
    expect(s.phase).toBe('stopping');
    // `began` no longer moves it on: the hook stops the recognizer instead.
    expect(run([{ type: 'began' }], s).phase).toBe('stopping');
  });
});

describe('the words in the field', () => {
  it('joins what you say after what you typed', () => {
    expect(joinDictation('', ' hello ')).toBe('hello');
    expect(joinDictation('Tell Inbox', 'to archive')).toBe('Tell Inbox to archive');
    expect(joinDictation('Line ', 'two')).toBe('Line two');
    expect(joinDictation('kept', '  ')).toBe('kept');
  });

  it('settles the words a partial shares with the last, never its last word', () => {
    expect(stablePrefix('', 'can you')).toBe(0);
    expect(stablePrefix('can you', 'can you draft')).toBe('can you '.length);
    expect(stablePrefix('can you draft', 'can you draft')).toBe('can you '.length);
    // A revision un-settles from where it changed.
    expect(stablePrefix('can you draft the', 'Can you draft the')).toBe(0);
    expect(stablePrefix('send it to', 'send it two me')).toBe('send it '.length);
  });

  it('splits the draft into settled and still-deciding, which together are the draft', () => {
    let s = run([
      { type: 'request', draft: 'Ask' },
      { type: 'began' },
      { type: 'result', transcript: 'Inbox to', isFinal: false },
    ]);
    expect(dictationDisplay(s)).toEqual({ settled: 'Ask ', deciding: 'Inbox to' });
    s = run([{ type: 'result', transcript: 'Inbox to archive', isFinal: false }], s);
    expect(dictationDisplay(s)).toEqual({ settled: 'Ask Inbox to ', deciding: 'archive' });
    s = run([{ type: 'result', transcript: 'Inbox to archive.', isFinal: true }], s);
    expect(dictationDisplay(s)).toEqual({ settled: 'Ask Inbox to archive.', deciding: '' });
    const { settled, deciding } = dictationDisplay(s);
    expect(settled + deciding).toBe(draftText(s));
  });
});

describe('what the phone can do', () => {
  it('is off without the native module (Expo Go), pointing at the keyboard', () => {
    expect(dictationSupport(null)).toBe('no-module');
    expect(dictationHint('no-module')).toMatch(/keyboard/);
  });

  it('prefers the phone, and otherwise says where the words go', () => {
    expect(dictationSupport(fakeRecognizer() as never)).toBe('on-device');
    expect(dictationSupport(fakeRecognizer({ onDevice: false }) as never)).toBe('server');
    expect(dictationSupport(fakeRecognizer({ available: false }) as never)).toBe('unavailable');
    expect(listeningNote('on-device')).toBeNull();
    expect(listeningNote('server', 'ios')).toMatch(/Apple/);
    expect(listeningNote('server', 'ios')).toMatch(/Apple, off this phone/);
    // Android's service is whichever the phone has: nobody is named.
    expect(listeningNote('server', 'android')).toBe('Recognised off this phone');
  });

  it('treats Android before 13 as off the phone, whatever the module says', () => {
    const r = fakeRecognizer();
    expect(dictationSupport(r as never, { OS: 'android', Version: 32 })).toBe('server');
    expect(dictationSupport(r as never, { OS: 'android', Version: 33 })).toBe('on-device');
    expect(dictationSupport(r as never, { OS: 'ios', Version: '17.0' })).toBe('on-device');
  });

  it('gives every problem plain words, and a fix where there is one', () => {
    expect(problemFromError('not-allowed', false)).toBe('permission');
    expect(problemFromError('network', true)).toBe('network');
    expect(problemFromError('busy', false)).toBe('busy');
    expect(problemFromError('interrupted', true)).toBe('interrupted');
    expect(problemFromError('audio-capture', true)).toBe('microphone');
    expect(problemFromError('aborted', false)).toBeNull();
    expect(problemFromError('no-speech', true)).toBeNull();
    expect(problemFromError('no-speech', false)).toBe('nothing-heard');
    expect(problemFromError('something new', false)).toBe('failed');
    expect(problemCopy('permission').fix).toBe('settings');
    expect(problemCopy('network').text).toMatch(/Wi-Fi/);
    expect(problemCopy('busy').fix).toBe('retry');
  });
});

describe('silence', () => {
  it('stops a few seconds after your voice, and gives up sooner on nothing', () => {
    const at = { startedAt: 0, lastVoiceAt: 1000 };
    expect(silenceStops({ ...at, now: 1000 + AUTO_STOP_SILENCE_MS - 1, heard: true })).toBe(false);
    expect(silenceStops({ ...at, now: 1000 + AUTO_STOP_SILENCE_MS, heard: true })).toBe(true);
    expect(
      silenceStops({ startedAt: 0, lastVoiceAt: 0, now: NOTHING_HEARD_MS - 1, heard: false })
    ).toBe(false);
    expect(
      silenceStops({ startedAt: 0, lastVoiceAt: 0, now: NOTHING_HEARD_MS, heard: false })
    ).toBe(true);
  });
});

describe('the hook', () => {
  it('listens on the device, streams words into the draft, Stop keeps them, and never sends', async () => {
    const r = fakeRecognizer();
    const { hook, draft } = await setup(r, 'Ask Inbox');
    await act(async () => {
      await hook.result.current.start();
    });
    expect(r.started[0]).toMatchObject({
      requiresOnDeviceRecognition: true,
      interimResults: true,
      contextualStrings: ['Chief of Staff', 'Inbox'],
      volumeChangeEventOptions: { enabled: true },
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
    expect(r.stop).toHaveBeenCalled();
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.outcome).toBe('done');
    expect(draft()).toBe('Ask Inbox to archive receipts today');
  });

  it('falls back to the platform’s recognizer when the phone can’t, and says so', async () => {
    const r = fakeRecognizer({ onDevice: false });
    const { hook } = await setup(r);
    expect(hook.result.current.support).toBe('server');
    await act(async () => {
      expect(await hook.result.current.start()).toBe(true);
    });
    expect(r.started[0]).toMatchObject({ requiresOnDeviceRecognition: false });
  });

  it('tries the platform’s recognizer once when the phone’s can’t start, on the same clock', async () => {
    const r = fakeRecognizer({ onDeviceFails: true });
    const { hook, draft } = await setup(r);
    await act(async () => {
      await hook.result.current.start();
    });
    expect(r.started.map((o) => o.requiresOnDeviceRecognition)).toEqual([true, false]);
    expect(hook.result.current.phase).toBe('listening');
    expect(hook.result.current.via).toBe('server');
    expect(hook.result.current.problem).toBeNull();
    await act(() => r.fire('result', { isFinal: false, results: [{ transcript: 'hello' }] }));
    expect(draft()).toBe('hello');
  });

  it('shows the error when the platform’s recognizer fails too, rather than loop', async () => {
    const r = fakeRecognizer({ onDeviceFails: true });
    const { hook } = await setup(r);
    await act(async () => {
      await hook.result.current.start();
    });
    await act(() => r.fire('error', { error: 'audio-capture', message: '' }));
    await act(() => r.fire('end'));
    expect(r.start).toHaveBeenCalledTimes(2);
    expect(hook.result.current.problem).toBe('microphone');
    expect(fallsBackToServer('audio-capture', 'on-device', true)).toBe(false);
    expect(fallsBackToServer('network', 'on-device', false)).toBe(false);
  });

  it('× puts back what was typed', async () => {
    const r = fakeRecognizer();
    const { hook, draft } = await setup(r, 'Typed');
    await act(async () => {
      await hook.result.current.start();
    });
    await act(() => r.fire('result', { isFinal: false, results: [{ transcript: 'oops' }] }));
    expect(draft()).toBe('Typed oops');
    await act(() => hook.result.current.cancel());
    expect(r.abort).toHaveBeenCalled();
    expect(draft()).toBe('Typed');
    expect(hook.result.current.outcome).toBe('cancelled');
  });

  it('Send keeps what is on screen, aborts the recognizer, and takes no late words', async () => {
    const r = fakeRecognizer();
    const { hook, draft } = await setup(r, 'Ask Inbox');
    await act(async () => {
      await hook.result.current.start();
    });
    await act(() => r.fire('result', { isFinal: false, results: [{ transcript: 'to archive' }] }));
    await act(() => hook.result.current.send());
    expect(r.abort).toHaveBeenCalled();
    expect(r.stop).not.toHaveBeenCalled();
    expect(hook.result.current).toMatchObject({ phase: 'idle', outcome: 'sent', problem: null });
    // The draft the composer sends is the one that was on screen.
    expect(draft()).toBe('Ask Inbox to archive');
    await act(() => r.fire('result', { isFinal: true, results: [{ transcript: 'late' }] }));
    expect(draft()).toBe('Ask Inbox to archive');
  });

  it('drops words still on their way once the draft is sent', async () => {
    const r = fakeRecognizer();
    const { hook, draft } = await setup(r);
    await act(async () => {
      await hook.result.current.start();
    });
    await act(() => r.fire('result', { isFinal: false, results: [{ transcript: 'hello' }] }));
    // The composer took the draft and emptied it.
    await act(() => hook.result.current.drop());
    await act(() => r.fire('result', { isFinal: true, results: [{ transcript: 'late' }] }));
    expect(draft()).toBe('hello');
    expect(r.abort).toHaveBeenCalled();
  });

  it('passes the voice level on, and rests it at 0 when it stops', async () => {
    const r = fakeRecognizer();
    const { hook, levels } = await setup(r);
    await act(async () => {
      await hook.result.current.start();
    });
    await act(() => r.fire('volumechange', { value: 8 }));
    await act(() => r.fire('volumechange', { value: -2 }));
    expect(levels[0]).toBeGreaterThan(0.5);
    expect(levels[1]).toBe(0);
    await act(() => hook.result.current.stop());
    expect(levels.at(-1)).toBe(0);
  });

  it('stops by itself after the silence that follows speech', async () => {
    jest.useFakeTimers();
    try {
      const r = fakeRecognizer();
      const clock = { t: 1000 };
      const { hook } = await setup(r, '', clock);
      await act(async () => {
        await hook.result.current.start();
      });
      await act(() => r.fire('result', { isFinal: false, results: [{ transcript: 'one' }] }));
      clock.t += AUTO_STOP_SILENCE_MS - 500;
      await act(() => jest.advanceTimersByTime(300));
      expect(hook.result.current.phase).toBe('listening');
      clock.t += 600;
      await act(() => jest.advanceTimersByTime(300));
      expect(r.stop).toHaveBeenCalled();
      expect(hook.result.current.phase).toBe('idle');
      expect(hook.result.current.outcome).toBe('done');
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows a problem instead of a dead mic, and starts again after', async () => {
    const r = fakeRecognizer();
    const { hook } = await setup(r);
    await act(async () => {
      await hook.result.current.start();
    });
    await act(() => r.fire('error', { error: 'busy', message: '' }));
    await act(() => r.fire('end'));
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.problem).toBe('busy');
    await act(async () => {
      expect(await hook.result.current.start()).toBe(true);
    });
    expect(hook.result.current.phase).toBe('listening');
    expect(hook.result.current.problem).toBeNull();
  });

  it('says what it needs when permission is refused', async () => {
    const r = fakeRecognizer({ granted: false });
    const { hook } = await setup(r);
    await act(async () => {
      await hook.result.current.start();
    });
    expect(r.start).not.toHaveBeenCalled();
    expect(hook.result.current.problem).toBe('permission');
    expect(problemCopy('permission').fix).toBe('settings');
  });

  it('does nothing without a recognizer', async () => {
    const { hook } = await setup(null);
    await act(async () => {
      expect(await hook.result.current.start()).toBe(false);
    });
    expect(hook.result.current.phase).toBe('idle');
  });
});
