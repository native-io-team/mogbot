/**
 * Talk's loop: listening → countdown → sending → waiting → speaking →
 * listening, with Cancel, Send now, a voice during the countdown, skipping
 * a reply, quiet, interruptions, and a card that pauses everything and is
 * never answered by voice.
 */

import type { AgentMessage } from '@shipstudio/companion-protocol';
import {
  QUIET_ROUNDS,
  TALK_COUNTDOWN_MS,
  TALK_SILENCE_MS,
  TALK_START,
  approvalSpoken,
  newReplies,
  pauseDetail,
  secondsLeft,
  talkClock,
  talkLines,
  talkReducer,
  talkStart,
  talkStatus,
  type TalkEvent,
  type TalkState,
} from '../src/lib/talk';

const run = (s: TalkState, ...events: TalkEvent[]) => events.reduce(talkReducer, s);

const msg = (id: string, kind: AgentMessage['kind'], text: string, ts = 10): AgentMessage => ({
  id,
  agentId: 'a',
  ts,
  kind,
  text,
});

describe('the loop', () => {
  it('goes round: listening → countdown → sending → waiting → speaking → listening', () => {
    let s = talkStart(false, false);
    expect(s.phase).toBe('listening');
    s = run(s, { type: 'heard', text: 'Draft the launch email' });
    expect(s.phase).toBe('listening');
    s = run(s, { type: 'silence', now: 1000 });
    expect(s.phase).toBe('countdown');
    expect(s.sendAt).toBe(1000 + TALK_COUNTDOWN_MS);
    s = run(s, { type: 'tick', now: 1000 + TALK_COUNTDOWN_MS - 1 });
    expect(s.phase).toBe('countdown');
    s = run(s, { type: 'tick', now: 1000 + TALK_COUNTDOWN_MS });
    expect(s.phase).toBe('sending');
    expect(s.heard).toBe('Draft the launch email');
    s = run(s, { type: 'sent' });
    expect(s.phase).toBe('waiting');
    expect(s.heard).toBe('');
    expect(s.busy).toBe(true);
    s = run(s, { type: 'reply', id: 'r1' });
    expect(s.phase).toBe('speaking');
    expect(s.speaking).toBe('r1');
    // The turn ends while it reads: it finishes reading, then listens.
    s = run(s, { type: 'busy', busy: false });
    expect(s.phase).toBe('speaking');
    s = run(s, { type: 'spoken', id: 'r1' });
    expect(s.phase).toBe('listening');
    expect(s.speaking).toBeNull();
  });

  it('reads every reply of a turn in order, and waits while the turn still runs', () => {
    let s = run(talkStart(true, false), { type: 'reply', id: 'r1' }, { type: 'reply', id: 'r2' });
    expect(s.speaking).toBe('r1');
    expect(s.queue).toEqual(['r2']);
    s = run(s, { type: 'spoken', id: 'r1' });
    expect(s.speaking).toBe('r2');
    s = run(s, { type: 'spoken', id: 'r2' });
    expect(s.phase).toBe('waiting');
    s = run(s, { type: 'busy', busy: false });
    expect(s.phase).toBe('listening');
  });

  it('never reads a reply twice, and a stopped reading’s late callback is ignored', () => {
    let s = run(talkStart(true, false), { type: 'reply', id: 'r1' }, { type: 'reply', id: 'r1' });
    expect(s.queue).toEqual([]);
    s = run(s, { type: 'spoken', id: 'other' });
    expect(s.speaking).toBe('r1');
  });

  it('a turn that ends with nothing to read hands back to you', () => {
    const s = run(talkStart(true, false), { type: 'busy', busy: false });
    expect(s.phase).toBe('listening');
  });

  it('opens waiting when the agent is working', () => {
    expect(talkStart(true, false).phase).toBe('waiting');
  });
});

describe('the countdown', () => {
  const counting = run(TALK_START, { type: 'heard', text: 'hello' }, { type: 'silence', now: 0 });

  it('does not start before you have said anything', () => {
    expect(run(TALK_START, { type: 'silence', now: 0 }).phase).toBe('listening');
    expect(run(TALK_START, { type: 'heard', text: '  ' }, { type: 'silence', now: 0 }).phase).toBe(
      'listening'
    );
  });

  it('speaking again goes back to listening, with the words kept', () => {
    const s = run(counting, { type: 'voice' });
    expect(s.phase).toBe('listening');
    expect(s.heard).toBe('hello');
    expect(s.sendAt).toBeNull();
  });

  it('Cancel drops the words and listens again', () => {
    const s = run(counting, { type: 'cancel' });
    expect(s.phase).toBe('listening');
    expect(s.heard).toBe('');
  });

  it('Send now sends at once', () => {
    expect(run(counting, { type: 'sendNow' }).phase).toBe('sending');
    expect(run(TALK_START, { type: 'heard', text: 'hi' }, { type: 'sendNow' }).phase).toBe(
      'sending'
    );
    // Nothing heard: nothing to send.
    expect(run(TALK_START, { type: 'sendNow' }).phase).toBe('listening');
  });

  it('shows whole seconds left', () => {
    expect(secondsLeft(counting, 0)).toBe(2);
    expect(secondsLeft(counting, 1500)).toBe(1);
    expect(talkStatus(counting, 'Chief', 100)).toBe('Sending in 2');
  });
});

describe('the clock', () => {
  it('starts the countdown after the quiet, not before', () => {
    const s = run(TALK_START, { type: 'heard', text: 'hi' });
    expect(talkClock(s, { now: 1000, lastVoiceAt: 1000 - TALK_SILENCE_MS + 1 })).toBeNull();
    expect(talkClock(s, { now: 1000, lastVoiceAt: 1000 - TALK_SILENCE_MS })).toEqual({
      type: 'silence',
      now: 1000,
    });
  });

  it('a voice during the countdown cancels it; its end sends', () => {
    const s = run(TALK_START, { type: 'heard', text: 'hi' }, { type: 'silence', now: 5000 });
    expect(talkClock(s, { now: 5500, lastVoiceAt: 5200 })).toEqual({ type: 'voice' });
    expect(talkClock(s, { now: 5500, lastVoiceAt: 3000 })).toBeNull();
    expect(talkClock(s, { now: 5000 + TALK_COUNTDOWN_MS, lastVoiceAt: 3000 })).toEqual({
      type: 'tick',
      now: 5000 + TALK_COUNTDOWN_MS,
    });
  });

  it('does nothing while waiting or speaking', () => {
    expect(talkClock(talkStart(true, false), { now: 1e9, lastVoiceAt: 0 })).toBeNull();
  });
});

describe('approvals pause the loop and are never answered by voice', () => {
  it('a card arriving while it listens stops listening and drops the words', () => {
    const s = run(
      TALK_START,
      { type: 'heard', text: 'deploy it' },
      { type: 'approval', waiting: true }
    );
    expect(s.phase).toBe('paused');
    expect(s.pause).toBe('approval');
    expect(s.heard).toBe('');
  });

  it('nothing heard while paused is taken, nothing is sent, and Carry on does nothing', () => {
    let s = run(talkStart(true, false), { type: 'approval', waiting: true });
    s = run(s, { type: 'heard', text: 'yes allow it' }, { type: 'sendNow' }, { type: 'resume' });
    expect(s.phase).toBe('paused');
    expect(s.pause).toBe('approval');
    expect(s.heard).toBe('');
  });

  it('a reply being read is stopped, and read again once the card is answered', () => {
    let s = run(talkStart(true, false), { type: 'reply', id: 'r1' });
    expect(s.phase).toBe('speaking');
    s = run(s, { type: 'approval', waiting: true });
    expect(s.phase).toBe('paused');
    expect(s.speaking).toBeNull();
    s = run(s, { type: 'reply', id: 'r2' });
    expect(s.phase).toBe('paused');
    s = run(s, { type: 'approval', waiting: false });
    expect(s.phase).toBe('speaking');
    expect(s.speaking).toBe('r1');
    expect(s.queue).toEqual(['r2']);
  });

  it('answered, it goes back to waiting on the turn, or to you', () => {
    expect(
      run(
        talkStart(true, false),
        { type: 'approval', waiting: true },
        { type: 'approval', waiting: false }
      ).phase
    ).toBe('waiting');
    expect(
      run(TALK_START, { type: 'approval', waiting: true }, { type: 'approval', waiting: false })
        .phase
    ).toBe('listening');
  });

  it('opens paused when a card already waits, and says so aloud and on screen', () => {
    const s = talkStart(true, true);
    expect(s.phase).toBe('paused');
    expect(talkStatus(s, 'Chief', 0)).toBe('Chief needs your OK');
    expect(pauseDetail(s)).toMatch(/never by voice/);
    expect(approvalSpoken('Chief')).toMatch(/won’t answer it by voice/);
  });

  it('a card while another pause holds it still needs the tap', () => {
    let s = run(TALK_START, { type: 'interrupt' }, { type: 'approval', waiting: true });
    expect(s.pause).toBe('approval');
    s = run(s, { type: 'resume' });
    expect(s.phase).toBe('paused');
  });
});

describe('cancel, end, skip and pauses', () => {
  it('End stops everything for good', () => {
    const s = run(
      talkStart(true, false),
      { type: 'reply', id: 'r1' },
      { type: 'end' },
      { type: 'reply', id: 'r2' },
      { type: 'resume' }
    );
    expect(s.phase).toBe('ended');
    expect(s.queue).toEqual([]);
  });

  it('Talk now skips what is left to read and listens, even mid-turn', () => {
    const s = run(
      talkStart(true, false),
      { type: 'reply', id: 'r1' },
      { type: 'reply', id: 'r2' },
      { type: 'skip' }
    );
    expect(s.phase).toBe('listening');
    expect(s.queue).toEqual([]);
    expect(s.busy).toBe(true);
  });

  it('a reply that lands while you are talking waits until you have sent', () => {
    let s = run(TALK_START, { type: 'heard', text: 'and also' }, { type: 'reply', id: 'r1' });
    expect(s.phase).toBe('listening');
    expect(s.queue).toEqual(['r1']);
    s = run(s, { type: 'sendNow' }, { type: 'sent' });
    expect(s.phase).toBe('waiting');
  });

  it('a call takes the mic: paused, with what was being read kept for after', () => {
    let s = run(talkStart(true, false), { type: 'reply', id: 'r1' }, { type: 'interrupt' });
    expect(s.phase).toBe('paused');
    expect(s.pause).toBe('interrupted');
    s = run(s, { type: 'resume' });
    expect(s.speaking).toBe('r1');
  });

  it('the recognizer saying "interrupted" pauses it with the plain line', () => {
    const s = run(TALK_START, { type: 'micProblem', problem: 'interrupted' });
    expect(s.pause).toBe('interrupted');
    expect(pauseDetail(s)).toBe('A call or another app took the microphone.');
  });

  it('a refused microphone is a problem to fix, not a loop', () => {
    const s = run(TALK_START, { type: 'micProblem', problem: 'permission' });
    expect(s.pause).toBe('problem');
    expect(pauseDetail(s)).toMatch(/microphone/);
  });

  it(`stops listening after ${QUIET_ROUNDS} quiet sessions in a row; speaking resets the count`, () => {
    let s = run(
      TALK_START,
      { type: 'nothingHeard' },
      { type: 'micProblem', problem: 'nothing-heard' }
    );
    expect(s.phase).toBe('listening');
    expect(s.quietRounds).toBe(2);
    expect(run(s, { type: 'heard', text: 'hi' }).quietRounds).toBe(0);
    s = run(s, { type: 'nothingHeard' });
    expect(s.pause).toBe('quiet');
    s = run(s, { type: 'resume' });
    expect(s.phase).toBe('listening');
    expect(s.quietRounds).toBe(0);
  });

  it('a failed send pauses with the reason; Carry on listens again', () => {
    let s = run(TALK_START, { type: 'heard', text: 'hi' }, { type: 'sendNow' });
    s = run(s, { type: 'sendFailed', message: 'The Mac refused it.' });
    expect(s.pause).toBe('problem');
    expect(pauseDetail(s)).toBe('The Mac refused it.');
    expect(run(s, { type: 'resume' }).phase).toBe('listening');
  });
});

describe('what it reads and shows', () => {
  const messages = [
    msg('old', 'agent', 'Before Talk', 1),
    msg('u1', 'user', 'Draft the email', 20),
    msg('card', 'approval', '', 21),
    msg('r1', 'agent', '**Done.** It’s in your drafts.', 22),
    msg('n', 'note', 'Started fresh', 23),
    msg('e', 'error', 'The turn failed: usage limit.', 24),
  ];

  it('reads replies and failures that landed since it opened, not cards or notes', () => {
    expect(newReplies(messages, new Set(['old'])).map((m) => m.id)).toEqual(['r1', 'e']);
  });

  it('shows the last lines since it opened, as said, with what it hears now last', () => {
    const lines = talkLines(messages, 10, 'and send it');
    expect(lines.map((l) => [l.who, l.text])).toEqual([
      ['you', 'Draft the email'],
      ['agent', 'Done. It’s in your drafts.'],
      ['agent', 'The turn failed: usage limit.'],
      ['you', 'and send it'],
    ]);
    expect(talkLines(messages, 10, '', 2)).toHaveLength(2);
  });
});
