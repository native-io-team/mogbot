import { describe, expect, it } from 'vitest';
import { countLine } from './RoomEditorModal';

describe('the members count', () => {
  it('says what is still needed, then that the room is full', () => {
    expect(countLine(0)).toBe('0 of 6 · pick two');
    expect(countLine(1)).toBe('1 of 6 · pick one more');
    expect(countLine(2)).toBe('2 of 6');
    expect(countLine(6)).toBe('6 of 6 · full');
  });
});
