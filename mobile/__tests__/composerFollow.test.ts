/**
 * The message field past six lines: it follows the newest line while it
 * listens and while the caret is at the end, and holds still while you edit
 * further up (components/Composer.tsx, `ComposerField`).
 */

import { followsEnd } from '../src/lib/composer';

const text = 'Okay so for the launch on Thursday I want the email to go out first';

describe('followsEnd', () => {
  it('always follows while listening, wherever the caret was', () => {
    expect(followsEnd({ dictating: true, caret: { start: 3, end: 3 }, length: text.length })).toBe(
      true
    );
    expect(followsEnd({ dictating: true, caret: { start: 0, end: 9 }, length: 40 })).toBe(true);
  });

  it('follows a caret not put anywhere yet: typing goes at the end', () => {
    expect(followsEnd({ dictating: false, caret: null, length: text.length })).toBe(true);
  });

  it('follows with the caret at the end', () => {
    const end = text.length;
    expect(followsEnd({ dictating: false, caret: { start: end, end }, length: end })).toBe(true);
  });

  it('still follows when the text grew before the caret moved with it', () => {
    // onChangeText (and the new size) arrive before onSelectionChange.
    const before = text.length;
    expect(
      followsEnd({
        dictating: false,
        caret: { start: before, end: before },
        length: before + 6,
        before,
      })
    ).toBe(true);
  });

  it('holds still with the caret further up', () => {
    expect(followsEnd({ dictating: false, caret: { start: 12, end: 12 }, length: text.length })).toBe(
      false
    );
    // Typing up there grows the text, and still it holds.
    expect(
      followsEnd({
        dictating: false,
        caret: { start: 12, end: 12 },
        length: text.length + 1,
        before: text.length,
      })
    ).toBe(false);
  });

  it('holds still over a selection, even one that runs to the end', () => {
    const end = text.length;
    expect(followsEnd({ dictating: false, caret: { start: 4, end }, length: end })).toBe(false);
  });

  it('follows when the text shrank under a caret that was at the end', () => {
    // Deleting the last word: the length drops before the caret is reported.
    expect(
      followsEnd({ dictating: false, caret: { start: 40, end: 40 }, length: 34, before: 40 })
    ).toBe(true);
  });
});
