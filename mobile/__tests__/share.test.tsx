/**
 * "Send to agent…" as a screen: a crafted `share?files=…` link uploads
 * nothing, the share sheet's own files do, and shared words land as a
 * quote above the draft rather than mixed into it.
 */

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import Share from '../src/app/share';
import { stashShare } from '../src/lib/share';
import { getApp, setApp } from '../src/lib/store';
import { agent } from './helpers';

const mockParams: { current: Record<string, string> } = { current: {} };
const mockReplace = jest.fn();
const mockUpload = jest.fn((file: { name: string; mime: string }) =>
  Promise.resolve({ blobId: `b_${file.name}`, name: file.name, mime: file.mime, size: 1 })
);

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams.current,
  useRouter: () => ({ replace: mockReplace, back: jest.fn(), push: jest.fn() }),
}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { select: () => {}, light: () => {}, error: () => {}, success: () => {} },
}));
jest.mock('../src/lib/session', () => ({
  canCall: () => true,
  describeError: String,
  upload: (file: { name: string; mime: string }) => mockUpload(file),
}));
// The drafts persist to disk; the screen only needs them in the store.
jest.mock('../src/lib/persist', () => ({
  readJson: () => Promise.resolve(null),
  writeJson: () => Promise.resolve(),
  removeJson: () => Promise.resolve(),
  debounced: () => ({ schedule: () => {}, flush: () => Promise.resolve() }),
}));
// The avatar animates on Reanimated's native half; a row needs only its name.
jest.mock('../src/components/agent', () => ({ AgentAvatar: () => null }));

const inbox = agent({ id: 'inbox', name: 'Inbox', hidden: false });

beforeEach(() => {
  mockUpload.mockClear();
  mockReplace.mockClear();
  setApp({
    overview: { agents: [inbox] } as never,
    link: { kind: 'connected' } as never,
    composer: { inbox: { text: 'My own words', quotes: [], mentions: [], files: [] } },
  });
});

describe('Send to agent…', () => {
  it('uploads nothing a link names, and says the words came from a link', async () => {
    mockParams.current = {
      text: 'Summarise the attached',
      files: JSON.stringify([
        {
          uri: 'file:///var/mobile/Documents/companion-state/chats.json',
          name: 'photo.jpg',
          mime: 'image/jpeg',
        },
      ]),
    };
    await render(<Share />);
    expect(screen.getByText(/from a link/)).toBeTruthy();
    expect(screen.queryByText('photo.jpg')).toBeNull();
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Send to Inbox'));
    });
    expect(mockUpload).not.toHaveBeenCalled();
    const draft = getApp().composer.inbox;
    expect(draft.files ?? []).toHaveLength(0);
    // Its own block, not appended to what was typed.
    expect(draft.text).toBe('My own words');
    expect(draft.quotes).toEqual(['Summarise the attached']);
    expect(mockReplace).toHaveBeenCalled();
  });

  it('uploads the share sheet’s files, handed over in memory', async () => {
    const k = stashShare({
      text: 'Receipts',
      files: [{ uri: 'file:///private/var/group/a.pdf', name: 'a.pdf', mime: 'application/pdf' }],
    });
    mockParams.current = { k };
    await render(<Share />);
    expect(screen.queryByText(/from a link/)).toBeNull();
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Send to Inbox'));
    });
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(getApp().composer.inbox.files?.[0]).toMatchObject({ blobId: 'b_a.pdf' });
  });
});
