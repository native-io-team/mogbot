/**
 * Listen: a reply read aloud on the phone, as it would be said, one at a
 * time, with Pause and Stop, and a late callback from a stopped reading never
 * ending the next one.
 */

import { messageActions } from '../src/lib/actions';
import {
  SPEECH_CHUNK,
  pauseReading,
  readAloud,
  readingBar,
  resumeReading,
  setSpeechForTests,
  speakable,
  speechChunks,
  stopReading,
  useReading,
} from '../src/lib/readAloud';

interface Spoken {
  text: string;
  options: { onDone?: () => void; onStopped?: () => void; useApplicationAudioSession?: boolean };
}

function fakeSpeech() {
  const spoken: Spoken[] = [];
  const api = {
    spoken,
    speak: jest.fn((text: string, options: Spoken['options']) => spoken.push({ text, options })),
    stop: jest.fn(() => Promise.resolve()),
    pause: jest.fn(() => Promise.resolve()),
    resume: jest.fn(() => Promise.resolve()),
  };
  setSpeechForTests(api as never);
  return api;
}

afterEach(() => {
  stopReading();
  setSpeechForTests(undefined);
});

describe('what is said', () => {
  it('drops the marks, says code as code, and a bare link as its site', () => {
    expect(
      speakable(
        [
          '## Done',
          '',
          'I **fixed** the `login` bug. See [the PR](https://github.com/a/b/pull/1).',
          '',
          '```ts',
          'const x = 1;',
          '```',
          '',
          '- one',
          '- two',
          '',
          'Logs: https://www.example.com/logs?id=3',
        ].join('\n')
      )
    ).toBe(
      'Done\n\nI fixed the login bug. See the PR.\n\nCode.\n\none\ntwo\n\nLogs: a link to example.com'
    );
  });

  it('cuts a long reply at sentence ends, every piece within what the engine takes', () => {
    const sentence = 'This is one sentence of a long reply. ';
    const text = sentence.repeat(300).trim();
    const parts = speechChunks(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= SPEECH_CHUNK)).toBe(true);
    expect(parts.every((p) => p.endsWith('.'))).toBe(true);
    expect(parts.join(' ')).toBe(text);
    // No sentence end in reach: a space, else a hard cut.
    expect(speechChunks('a'.repeat(9), 4)).toEqual(['aaaa', 'aaaa', 'a']);
  });
});

describe('reading aloud', () => {
  it('offers Listen on an agent’s reply only, and only in a build that can', () => {
    const reply = { kind: 'agent' as const, text: 'Hello there' };
    expect(messageActions(reply, false, true).map((a) => a.id)).toContain('listen');
    expect(messageActions(reply, false, false).map((a) => a.id)).not.toContain('listen');
    expect(
      messageActions({ kind: 'user', text: 'Hi' }, false, true).map((a) => a.id)
    ).not.toContain('listen');
  });

  it('says nothing and reports it in a build without a voice', () => {
    setSpeechForTests(null);
    expect(readAloud('a1', 'm1', 'Hello')).toBe(false);
    expect(useReading.getState().reading).toBeNull();
  });

  it('reads in the app’s own session, ends with the last piece, and pauses and stops', () => {
    const api = fakeSpeech();
    expect(readAloud('a1', 'm1', 'Hello there.')).toBe(true);
    expect(api.speak).toHaveBeenCalledTimes(1);
    expect(api.spoken[0].options.useApplicationAudioSession).toBe(true);
    expect(useReading.getState().reading).toEqual({
      agentId: 'a1',
      messageId: 'm1',
      paused: false,
    });
    expect(readingBar(useReading.getState().reading, 'a1')?.title).toBe('Reading aloud');
    // Only in its own chat.
    expect(readingBar(useReading.getState().reading, 'a2')).toBeNull();
    pauseReading();
    expect(api.pause).toHaveBeenCalled();
    expect(readingBar(useReading.getState().reading, 'a1')?.title).toBe('Paused');
    resumeReading();
    expect(api.resume).toHaveBeenCalled();
    api.spoken[0].options.onDone?.();
    expect(useReading.getState().reading).toBeNull();
  });

  it('starting another reply stops the first, whose late callbacks change nothing', () => {
    const api = fakeSpeech();
    readAloud('a1', 'm1', 'First.');
    readAloud('a1', 'm2', 'Second.');
    expect(api.stop).toHaveBeenCalledTimes(2);
    api.spoken[0].options.onStopped?.();
    expect(useReading.getState().reading?.messageId).toBe('m2');
    stopReading();
    expect(useReading.getState().reading).toBeNull();
    expect(api.stop).toHaveBeenCalledTimes(3);
  });
});
