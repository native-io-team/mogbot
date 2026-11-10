import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from '@tauri-apps/plugin-updater';
import { UpdateBanner, parseReleaseNotes } from './UpdateBanner';
import { checkForUpdate, downloadUpdate, installUpdate, restartApp } from '../lib/updater';
import { checkForUpdatesNow, resetUpdateStoreForTests } from '../lib/updateStore';
import { agentsBusy } from '../lib/agents';

vi.mock('../lib/updater', () => ({
  UPDATES_ENABLED: true,
  isMockUpdateSimulationEnabled: () => false,
  checkForUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  releaseUpdate: vi.fn(() => Promise.resolve()),
  restartApp: vi.fn(),
}));

vi.mock('../lib/agents', () => ({
  agentsBusy: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('../lib/analytics', () => ({
  trackEvent: vi.fn(),
  trackError: vi.fn(),
}));

function offer(version: string, body = '') {
  vi.mocked(checkForUpdate).mockResolvedValue({
    update: { version } as unknown as Update,
    info: { version, date: undefined, body },
  });
}

describe('parseReleaseNotes', () => {
  it('parses only the available version into titles and full details', () => {
    const body = `
## What's New in v0.18.0

- **Faster previews** - Preview startup now avoids duplicate work.
- **Sidebar polish** — Project controls stay visible at narrow widths.

## What's New in v0.17.1

- **Older fix** - This should not appear.
`;

    expect(parseReleaseNotes(body, '0.18.0')).toEqual([
      { title: 'Faster previews', detail: 'Preview startup now avoids duplicate work.' },
      { title: 'Sidebar polish', detail: 'Project controls stay visible at narrow widths.' },
    ]);
  });

  it('strips markdown from the published manifest body (bullet-dot notes, no heading)', () => {
    const body =
      '\n• **Visual editor breakthroughs** - Elements without a class can finally be inserted\n' +
      '• **Pages Router discovery** - Next.js projects with routes in `pages/` now show their pages\n';

    const notes = parseReleaseNotes(body, '0.18.7');

    expect(notes).toEqual([
      {
        title: 'Visual editor breakthroughs',
        detail: 'Elements without a class can finally be inserted',
      },
      {
        title: 'Pages Router discovery',
        detail: 'Next.js projects with routes in pages/ now show their pages',
      },
    ]);
    const rendered = notes.map((note) => `${note.title} ${note.detail ?? ''}`).join(' ');
    expect(rendered).not.toContain('**');
    expect(rendered).not.toContain('`');
  });

  it('keeps prose release notes instead of dropping them, markdown stripped', () => {
    const body = `## What's New in v0.19.0

**Visual editor breakthroughs** — elements without a class can be inserted.

A second paragraph mentioning \`pages/\` and a [link](https://example.com).`;

    expect(parseReleaseNotes(body, '0.19.0')).toEqual([
      {
        title: 'Visual editor breakthroughs',
        detail: 'elements without a class can be inserted.',
      },
      { title: 'A second paragraph mentioning pages/ and a link.', detail: undefined },
    ]);
  });

  it('reads the bullets of a whole docs/release-notes file (what latest.json carries)', () => {
    // The shape scripts/release-mac.sh publishes: the release page's notes,
    // prose and headings around one "What's in" list.
    const body = `# App 1.0 for Mac

An intro paragraph that is not a note.

## What's in 1.0

- **A Chief of Staff from the first launch.** It sets up the rest of your
  team from a sentence.
- **Agents that remember.** Each one keeps its own notes.

## What you need

- **A Mac with Apple Silicon**`;

    expect(parseReleaseNotes(body, '1.0.0')).toEqual([
      {
        title: 'A Chief of Staff from the first launch.',
        detail: 'It sets up the rest of your team from a sentence.',
      },
      { title: 'Agents that remember.', detail: 'Each one keeps its own notes.' },
    ]);
  });
});

describe('UpdateBanner', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', false);
    localStorage.clear();
    resetUpdateStoreForTests();
    vi.mocked(checkForUpdate).mockReset();
    vi.mocked(downloadUpdate).mockReset();
    vi.mocked(installUpdate).mockReset();
    vi.mocked(restartApp).mockReset();
    vi.mocked(agentsBusy).mockResolvedValue(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('says nothing while the update downloads, then offers Restart to update', async () => {
    offer('1.0.1', '## What’s new in 1.0.1\n\n- **Faster replies** - Less waiting.');
    let finish: (() => void) | undefined;
    vi.mocked(downloadUpdate).mockImplementation(
      (_update, onProgress) =>
        new Promise<void>((resolve) => {
          onProgress?.(40);
          finish = resolve;
        })
    );

    const { container } = render(<UpdateBanner />);
    let checked: Promise<unknown> = Promise.resolve();
    await act(async () => {
      checked = checkForUpdatesNow();
      await Promise.resolve();
    });
    await waitFor(() => expect(downloadUpdate).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();

    await act(async () => {
      finish?.();
      await checked;
    });

    expect(await screen.findByText('Restart to update')).toBeVisible();
    expect(screen.getByText('Version 1.0.1 is ready — view changes')).toBeInTheDocument();
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it('installs, then relaunches, on Restart to update', async () => {
    offer('1.0.1');
    vi.mocked(downloadUpdate).mockResolvedValue(undefined);
    const order: string[] = [];
    vi.mocked(installUpdate).mockImplementation(() => {
      order.push('install');
      return Promise.resolve();
    });
    vi.mocked(restartApp).mockImplementation(() => {
      order.push('restart');
      return Promise.resolve();
    });

    const user = userEvent.setup();
    render(<UpdateBanner />);
    await act(async () => {
      await checkForUpdatesNow();
    });

    await user.click(screen.getByRole('button', { name: 'Restart to update to version 1.0.1' }));
    await waitFor(() => expect(order).toEqual(['install', 'restart']));
  });

  it('nags once per version: Later stays dismissed across remounts and checks', async () => {
    offer('1.0.1');
    vi.mocked(downloadUpdate).mockResolvedValue(undefined);

    const user = userEvent.setup();
    const first = render(<UpdateBanner />);
    await act(async () => {
      await checkForUpdatesNow();
    });
    await user.click(screen.getByRole('button', { name: 'Not now: hide until the next version' }));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();

    // A new launch, the same version on the feed: still quiet.
    resetUpdateStoreForTests();
    const second = render(<UpdateBanner />);
    await act(async () => {
      await checkForUpdatesNow();
    });
    expect(second.container).toBeEmptyDOMElement();

    // A newer version is a new question.
    offer('1.0.2');
    await act(async () => {
      await checkForUpdatesNow();
    });
    expect(await screen.findByText('Version 1.0.2 is ready — view changes')).toBeInTheDocument();
  });

  it('a ⌘K check brings a dismissed update back', async () => {
    offer('1.0.1');
    vi.mocked(downloadUpdate).mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = render(<UpdateBanner />);
    await act(async () => {
      await checkForUpdatesNow();
    });
    await user.click(screen.getByRole('button', { name: 'Not now: hide until the next version' }));
    expect(container).toBeEmptyDOMElement();

    await act(async () => {
      await checkForUpdatesNow({ manual: true });
    });
    expect(await screen.findByText('Restart to update')).toBeVisible();
  });

  it('keeps a background download failure quiet', async () => {
    offer('1.0.1');
    vi.mocked(downloadUpdate).mockRejectedValue(new Error('signature verification failed'));
    const { container } = render(<UpdateBanner />);
    await act(async () => {
      await checkForUpdatesNow();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('says when installing failed and offers to try again', async () => {
    offer('1.0.1');
    vi.mocked(downloadUpdate).mockResolvedValue(undefined);
    vi.mocked(installUpdate).mockRejectedValueOnce(new Error('Permission denied'));

    const user = userEvent.setup();
    render(<UpdateBanner />);
    await act(async () => {
      await checkForUpdatesNow();
    });
    await user.click(screen.getByRole('button', { name: 'Restart to update to version 1.0.1' }));

    expect(await screen.findByText('Update needs attention')).toBeVisible();
    expect(restartApp).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Try updating to version 1.0.1 again' }));
    const dialog = screen.getByRole('dialog', { name: "What's new in 1.0.1" });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      "Couldn't install the update: Permission denied"
    );
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(restartApp).toHaveBeenCalledTimes(1));
    expect(installUpdate).toHaveBeenCalledTimes(2);
  });

  it('opens the notes from the banner, with no raw markdown', async () => {
    offer(
      '1.0.1',
      '\n• **Visual editor breakthroughs** - Elements without a class can be inserted\n'
    );
    vi.mocked(downloadUpdate).mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(<UpdateBanner />);
    await act(async () => {
      await checkForUpdatesNow();
    });
    await user.click(screen.getByRole('button', { name: "View what's new in version 1.0.1" }));

    const dialog = screen.getByRole('dialog', { name: "What's new in 1.0.1" });
    expect(
      within(dialog).getByRole('heading', { name: 'Visual editor breakthroughs' })
    ).toBeVisible();
    expect(dialog.textContent).not.toContain('**');
    expect(within(dialog).getByRole('button', { name: 'Later' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Restart to update' })).toBeVisible();
  });

  it('waits for working agents before restarting, unless asked again', async () => {
    offer('1.0.1');
    vi.mocked(downloadUpdate).mockResolvedValue(undefined);
    vi.mocked(agentsBusy).mockResolvedValue(2);

    const user = userEvent.setup();
    render(<UpdateBanner />);
    await act(async () => {
      await checkForUpdatesNow();
    });
    await user.click(screen.getByRole('button', { name: 'Restart to update to version 1.0.1' }));
    expect(await screen.findByText('After agents finish')).toBeVisible();
    expect(installUpdate).not.toHaveBeenCalled();
    expect(restartApp).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /once agents finish\. Restart now/ }));
    await waitFor(() => expect(restartApp).toHaveBeenCalledTimes(1));
  });
});
