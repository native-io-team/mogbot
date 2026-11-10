/**
 * VoiceOver and a streamed reply: the words moved while they streamed, so
 * when the reply lands in the chat that's open, VoiceOver reads it (as said
 * aloud, cut at a sentence); anywhere else only who replied.
 */

import { replyAnnouncement, SAY_REPLY_MAX } from '../src/lib/a11y';
import { speakable } from '../src/lib/readAloud';

describe('a reply, announced', () => {
  it('elsewhere: who replied', () => {
    expect(replyAnnouncement('Ada', 'Done.', false)).toBe('Ada replied');
  });

  it('in its chat: the words, as they are said', () => {
    expect(replyAnnouncement('Ada', speakable('**Done.** See https://example.com/x'), true)).toBe(
      'Ada: Done. See a link to example.com'
    );
  });

  it('a long one stops at a sentence and says there is more', () => {
    const long = `${'This sentence is filler for the test. '.repeat(12)}End.`;
    const said = replyAnnouncement('Ada', long, true);
    expect(said.length).toBeLessThan(SAY_REPLY_MAX + 40);
    expect(said).toMatch(/test\. More in the chat\.$/);
  });
});
