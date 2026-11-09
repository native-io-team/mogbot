import { moreToTheRight } from '../src/lib/overflow';

describe('moreToTheRight', () => {
  it('is true only while the line runs past the box', () => {
    expect(moreToTheRight(520, 300, 0)).toBe(true);
    expect(moreToTheRight(520, 300, 218)).toBe(true);
    expect(moreToTheRight(520, 300, 219.5)).toBe(false);
    expect(moreToTheRight(300, 300, 0)).toBe(false);
  });

  it('says nothing before both sizes are known', () => {
    expect(moreToTheRight(0, 300, 0)).toBe(false);
    expect(moreToTheRight(520, 0, 0)).toBe(false);
  });

  it('treats an overscroll bounce past the start as the start', () => {
    expect(moreToTheRight(520, 300, -40)).toBe(true);
  });
});
