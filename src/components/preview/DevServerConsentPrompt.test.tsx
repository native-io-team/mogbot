import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { DevServerConsentPrompt } from './DevServerConsentPrompt';
import {
  devServerConsentStore,
  type DevServerConsent,
  type PendingDevServerConsent,
} from '../../lib/devServerConsent';

const PROJECT = '/Users/me/ShipStudio/site';

function consent(state: DevServerConsent['state'], fingerprint = 'f1'): DevServerConsent {
  return {
    state,
    fingerprint,
    surface: {
      scripts: { dev: 'next dev', predev: 'node scripts/setup.js' },
      workspaceScripts: null,
      workspaceSubpath: null,
      customCommand: null,
    },
  };
}

describe('DevServerConsentPrompt', () => {
  let approved: { projectPath: string; fingerprint: string }[];
  let current: DevServerConsent;

  beforeEach(() => {
    approved = [];
    current = consent('new');
    mockIPC((cmd, args) => {
      const a = args as Record<string, string>;
      if (cmd === 'approve_dev_server') {
        if (a.fingerprint !== current.fingerprint) {
          throw new Error('This project’s dev command changed again.');
        }
        approved.push({ projectPath: a.projectPath, fingerprint: a.fingerprint });
        return null;
      }
      if (cmd === 'get_dev_server_consent') return current;
      return null;
    });
  });

  afterEach(() => {
    clearMocks();
    devServerConsentStore.clear(PROJECT);
  });

  it('shows every command that would run, and asks plainly for a new project', () => {
    const pending: PendingDevServerConsent = { consent: consent('new'), resume: vi.fn() };
    render(<DevServerConsentPrompt projectPath={PROJECT} pending={pending} />);
    expect(screen.getByText('Start the dev server?')).toBeTruthy();
    expect(screen.getByText('next dev')).toBeTruthy();
    expect(screen.getByText('node scripts/setup.js')).toBeTruthy();
  });

  it('says the scripts changed when they did', () => {
    const pending: PendingDevServerConsent = { consent: consent('changed'), resume: vi.fn() };
    render(<DevServerConsentPrompt projectPath={PROJECT} pending={pending} />);
    expect(screen.getByText('package.json scripts changed — Start dev server?')).toBeTruthy();
  });

  it('approves exactly what was shown, then starts the server', async () => {
    const resume = vi.fn();
    const pending: PendingDevServerConsent = { consent: consent('new'), resume };
    devServerConsentStore.set(PROJECT, pending);
    render(<DevServerConsentPrompt projectPath={PROJECT} pending={pending} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start dev server' }));
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(approved).toEqual([{ projectPath: PROJECT, fingerprint: 'f1' }]);
    expect(devServerConsentStore.get(PROJECT)).toBeNull();
  });

  it('starts nothing when the commands changed after they were shown', async () => {
    current = consent('changed', 'f2');
    const resume = vi.fn();
    const pending: PendingDevServerConsent = { consent: consent('new', 'f1'), resume };
    devServerConsentStore.set(PROJECT, pending);
    render(<DevServerConsentPrompt projectPath={PROJECT} pending={pending} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start dev server' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(resume).not.toHaveBeenCalled();
    expect(approved).toEqual([]);
    // The newer version is what's asked about now.
    expect(devServerConsentStore.get(PROJECT)?.consent.fingerprint).toBe('f2');
  });
});
