import { describe, it, expect, afterEach } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import {
  assertDevServerApproved,
  consentLines,
  DevServerConsentRequired,
  type DevServerConsent,
} from './devServerConsent';

const surface = {
  scripts: { dev: 'vite', build: 'vite build' },
  workspaceScripts: { dev: 'next dev' },
  workspaceSubpath: 'apps/web',
  customCommand: 'sh ./run.sh',
  workspaces: { 'packages/ui': { dev: 'tsc -w' } },
  files: { 'vite.config.ts': 'abc' },
};

describe('devServerConsent', () => {
  afterEach(() => clearMocks());

  it('lists the custom command first, then root scripts, then the workspace’s', () => {
    expect(consentLines(surface)).toEqual([
      { label: 'dev command', command: 'sh ./run.sh' },
      { label: 'dev', command: 'vite' },
      { label: 'build', command: 'vite build' },
      { label: 'apps/web › dev', command: 'next dev' },
      { label: 'packages/ui › dev', command: 'tsc -w' },
    ]);
  });

  it('refuses a spawn the user has not approved', async () => {
    const answer: DevServerConsent = {
      state: 'changed',
      fingerprint: 'x',
      surface,
      installScriptsPending: false,
    };
    mockIPC((cmd) => (cmd === 'get_dev_server_consent' ? answer : null));
    await expect(assertDevServerApproved('/p')).rejects.toBeInstanceOf(DevServerConsentRequired);
  });

  it('lets an approved one through', async () => {
    mockIPC((cmd) =>
      cmd === 'get_dev_server_consent'
        ? { state: 'approved', fingerprint: 'x', surface, installScriptsPending: false }
        : null
    );
    await expect(assertDevServerApproved('/p')).resolves.toBeUndefined();
  });
});
