import { describe, expect, it } from 'vitest';
import {
  insertMarkers,
  markerAtCaret,
  markersLost,
  notPlaced,
  placedImages,
  splitAtImages,
  withoutImages,
} from './inlineImages';

describe('insertMarkers', () => {
  it('puts the marker at the caret with a space either side', () => {
    const text = 'the header looks off';
    const caret = 'the header'.length;
    expect(insertMarkers(text, caret, caret, [1])).toEqual({
      value: 'the header [Image 1] looks off',
      caret: 'the header [Image 1]'.length,
    });
  });

  it('replaces a selection, and several images go in together', () => {
    expect(insertMarkers('see X here', 4, 5, [2, 3]).value).toBe('see [Image 2] [Image 3] here');
  });

  it('into an empty field, leaving a space to type after', () => {
    expect(insertMarkers('', 0, 0, [1])).toEqual({ value: '[Image 1] ', caret: 10 });
  });
});

describe('withoutImages', () => {
  it('takes the marker and one space out, and numbers the later ones down', () => {
    const text = 'a [Image 1] b [Image 2] c [Image 3]';
    expect(withoutImages(text, [2], 3).text).toBe('a [Image 1] b c [Image 2]');
  });

  it('leaves a marker past the image count alone (just words)', () => {
    expect(withoutImages('[Image 1] and [Image 9]', [1], 1).text).toBe('and [Image 9]');
  });

  it('moves the caret with the text', () => {
    const text = 'x [Image 1] y [Image 2] z';
    const caret = text.length;
    const next = withoutImages(text, [1], 2, caret);
    expect(next.text).toBe('x y [Image 1] z');
    expect(next.caret).toBe(next.text.length);
  });
});

describe('markersLost and markerAtCaret', () => {
  it('finds the images whose markers an edit took out', () => {
    expect(markersLost('a [Image 1] [Image 2]', 'a [Image 2]', 2)).toEqual([1]);
    expect(markersLost('a [Image 1]', 'a [Image', 1)).toEqual([1]);
    expect(markersLost('a', 'ab', 0)).toEqual([]);
  });

  it('Backspace after a marker, or Delete before one, takes it whole', () => {
    const text = 'see [Image 1] here';
    expect(markerAtCaret(text, 'see [Image 1]'.length, 'Backspace', 1)).toBe(1);
    expect(markerAtCaret(text, 4, 'Delete', 1)).toBe(1);
    expect(markerAtCaret(text, 3, 'Backspace', 1)).toBeNull();
    expect(markerAtCaret(text, 'see [Image 1]'.length, 'Backspace', 0)).toBeNull();
  });
});

describe('splitAtImages', () => {
  it('words and images in the order written, images on their own line', () => {
    expect(
      splitAtImages('the hero [Image 1] is too tall, and here [Image 2]\nfix both', 2)
    ).toEqual([
      { kind: 'text', text: 'the hero' },
      { kind: 'image', n: 1 },
      { kind: 'text', text: 'is too tall, and here' },
      { kind: 'image', n: 2 },
      { kind: 'text', text: 'fix both' },
    ]);
  });

  it('a marker with no image behind it stays words', () => {
    expect(splitAtImages('see [Image 3]', 2)).toEqual([{ kind: 'text', text: 'see [Image 3]' }]);
    expect(splitAtImages('plain words', 0)).toEqual([{ kind: 'text', text: 'plain words' }]);
  });

  it('places each image once', () => {
    expect(placedImages('[Image 1] and again [Image 1]', 1)).toEqual(new Set([1]));
  });
});

describe('notPlaced', () => {
  it('keeps files and images the words never placed, in order', () => {
    const files = [
      { name: 'a.png', mime: 'image/png' },
      { name: 'spec.pdf', mime: 'application/pdf' },
      { name: 'b.png', mime: 'image/png' },
    ];
    expect(notPlaced(files, new Set([1])).map((f) => f.name)).toEqual(['spec.pdf', 'b.png']);
    expect(notPlaced(files, new Set())).toHaveLength(3);
  });
});
