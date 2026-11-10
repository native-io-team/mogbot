/**
 * "When…" routines from the phone: the desk's composer, in its words
 * (`whenComposer.ts`), with the Mac's own folders and apps
 * (`agents.watch.options`), saving through `agents.watch.create|update`.
 */
import type { WatchOptions } from '@shipstudio/companion-protocol';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

const options: WatchOptions = {
  connections: [
    {
      service: 'gmail',
      title: 'Gmail',
      account: 'sam@example.com',
      kind: { type: 'oauth' },
      serverKey: 'gmail',
      grants: [{ agentId: 'a1' }],
    },
  ],
  claudeApps: [{ name: 'linear', target: 'https://mcp.linear.app/mcp', source: 'user' }],
  folders: [{ path: '/Users/sam/Downloads', label: '~/Downloads' }],
};
const mockOptions = jest.fn((_id: string) => Promise.resolve(options));
const mockCreate = jest.fn((..._a: unknown[]) => Promise.resolve({}));
const mockUpdate = jest.fn((..._a: unknown[]) => Promise.resolve({}));
jest.mock('../src/lib/session', () => ({
  describeError: (e: unknown) => String(e),
  watch: {
    options: (id: string) => mockOptions(id),
    create: (...a: unknown[]) => mockCreate(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));
jest.mock('react-native-reanimated', () =>
  jest.requireActual<typeof import('./reanimatedStub')>('./reanimatedStub').reanimated()
);
jest.mock('expo-router', () => ({ useIsFocused: () => true }));
jest.mock('../src/lib/haptics', () => ({ haptic: { select: jest.fn(), error: jest.fn() } }));

import { WhenComposer } from '../src/components/whenComposer';

const agent = { id: 'a1', name: 'Finance' };

async function mount(editing: Parameters<typeof WhenComposer>[0]['editing'] = null) {
  const onDone = jest.fn();
  await render(
    <WhenComposer agent={agent} editing={editing} onDone={onDone} onCancel={jest.fn()} />
  );
  await act(async () => {});
  return onDone;
}

describe('the phone’s “When…” composer', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockUpdate.mockClear();
  });

  it('offers the desk’s sources, from your Mac, Linear only with a Linear app', async () => {
    await mount();
    expect(screen.getByText('WHEN THIS HAPPENS')).toBeTruthy();
    expect(screen.getByText('Someone mentions you on GitHub')).toBeTruthy();
    expect(screen.getAllByText('Free · checked from your Mac')).toHaveLength(2);
    expect(screen.getByText('A Linear issue is assigned to you')).toBeTruthy();
    expect(screen.getByText('CHECK EVERY')).toBeTruthy();
    expect(screen.getByText(/^Checks are free\. The first check only notes/)).toBeTruthy();
  });

  it('echoes the routine and adds it with the source, interval and note', async () => {
    const onDone = await mount();
    await fireEvent.changeText(
      screen.getByPlaceholderText('Triage it and tell me if it’s urgent'),
      'Triage it'
    );
    expect(screen.getByText('When someone mentions you on GitHub — Triage it')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('every 30 min'));
    await fireEvent.press(screen.getByText('Add'));
    expect(mockCreate).toHaveBeenCalledWith('a1', { kind: 'github_mentions' }, 30, 'Triage it');
    expect(onDone).toHaveBeenCalled();
  });

  it('a folder is one the Mac offers, never typed', async () => {
    await mount();
    await fireEvent.press(screen.getByText('A new file appears in a folder'));
    expect(screen.getByText('Which folder?')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Folder, e\.g\./)).toBeNull();
    await fireEvent.press(screen.getByText('~/Downloads'));
    await fireEvent.changeText(
      screen.getByPlaceholderText('Triage it and tell me if it’s urgent'),
      'File it'
    );
    await fireEvent.press(screen.getByText('Add'));
    expect(mockCreate).toHaveBeenCalledWith(
      'a1',
      { kind: 'new_file', folder: '/Users/sam/Downloads' },
      10,
      'File it'
    );
  });

  it('something else asks what, then which app, and says what each check costs', async () => {
    await mount();
    await fireEvent.press(screen.getByText('Something else…'));
    expect(screen.getByText('What should it look out for?')).toBeTruthy();
    await fireEvent.changeText(
      screen.getByPlaceholderText(/^What to look for/),
      'a new email from Dana'
    );
    expect(screen.getByText('Which app should it check?')).toBeTruthy();
    await fireEvent.press(screen.getByText('Gmail'));
    expect(screen.getByText('When Finance finds “a new email from Dana”')).toBeTruthy();
    expect(
      screen.getByText(
        /^Each check uses a little of Finance’s usage and can only read that app, up to 24 a day\./
      )
    ).toBeTruthy();
  });

  it('edits a routine in place', async () => {
    await mount({
      id: 'w1',
      note: 'Triage it',
      nextAt: 0,
      createdAt: 0,
      paused: false,
      watch: { source: { kind: 'github_assigned' }, everyMinutes: 60, lastFound: 0, failures: 0 },
    });
    await fireEvent.press(screen.getByText('Save'));
    expect(mockUpdate).toHaveBeenCalledWith(
      'a1',
      'w1',
      { kind: 'github_assigned' },
      60,
      'Triage it'
    );
  });
});
