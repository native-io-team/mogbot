/**
 * Picking more files than there's room for (#9): what fits goes in, and one
 * sentence says how many of how many, and the limit. Never nothing, silently.
 * The photo picker is never opened with no room, where its `selectionLimit`
 * of 0 would mean "no limit".
 */

import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '@shipstudio/companion-protocol';
import * as ImagePicker from 'expo-image-picker';
import { admit, full, pickPhotos, type PickedFile } from '../src/lib/files';

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
}));

const photo = (i: number, size = 1000): PickedFile => ({
  uri: `file:///p${i}.jpg`,
  name: `p${i}.jpg`,
  mime: 'image/jpeg',
  size,
});
const photos = (n: number) => Array.from({ length: n }, (_, i) => photo(i));

describe('admitting picked files', () => {
  it('keeps everything that fits and says nothing', () => {
    expect(admit(photos(3), MAX_ATTACHMENTS)).toEqual({ kept: photos(3), refused: null });
  });

  it('past the limit, keeps up to it and says how many of how many, and the limit', () => {
    const { kept, refused } = admit(photos(14), MAX_ATTACHMENTS);
    expect(kept).toHaveLength(MAX_ATTACHMENTS);
    expect(refused).toBe(
      `Added ${MAX_ATTACHMENTS} of 14. You can attach up to ${MAX_ATTACHMENTS} files at a time.`
    );
  });

  it('counts the room left by files already attached', () => {
    const { kept, refused } = admit(photos(5), 3);
    expect(kept).toEqual(photos(3));
    expect(refused).toMatch(/^Added 3 of 5\./);
  });

  it('with no room, adds none and says why and what to do', () => {
    for (const room of [0, -2, Number.NaN]) {
      const { kept, refused } = admit(photos(4), room);
      expect(kept).toEqual([]);
      expect(refused).toBe(full());
    }
    expect(full()).toMatch(/already attached/);
  });

  it('says which file is too big, and still how many went in', () => {
    const files = [...photos(11), photo(99, MAX_ATTACHMENT_BYTES + 1)];
    const { kept, refused } = admit(files, MAX_ATTACHMENTS);
    expect(kept).toHaveLength(MAX_ATTACHMENTS);
    expect(refused).toMatch(/^p99\.jpg is \d+ MB\./);
    expect(refused).toMatch(/Added 10 of 11\./);
  });
});

describe('the photo picker', () => {
  const launch = ImagePicker.launchImageLibraryAsync as jest.Mock;
  beforeEach(() => launch.mockClear());

  it('stops at the room left', async () => {
    await pickPhotos(4);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ allowsMultipleSelection: true, selectionLimit: 4 })
    );
  });

  it('is never opened with no room (a limit of 0 means no limit to it)', async () => {
    await expect(pickPhotos(0)).rejects.toThrow(full());
    expect(launch).not.toHaveBeenCalled();
  });
});
