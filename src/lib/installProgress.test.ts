import { describe, expect, it } from 'vitest';
import {
  describeFailure,
  installSteps,
  laterPhase,
  MOCK_FAILURES,
  mockScript,
  phaseFromOutput,
  promptOf,
  QUESTION_QUIET_MS,
  signInUrlOf,
  stepState,
} from './installProgress';

const played = (itemId: string, failure: (typeof MOCK_FAILURES)[number] | null = null) =>
  mockScript(itemId, failure)
    .lines.map((l) => l.text)
    .join('\n');

describe('installSteps', () => {
  it('names the download, then installs, then checks', () => {
    expect(installSteps('claude').map((s) => s.label)).toEqual([
      'Downloading Claude Code',
      'Installing',
      'Checking it works',
    ]);
  });

  it('an npm install is one step, since nothing it prints tells the two apart', () => {
    expect(installSteps('codex').map((s) => s.label)).toEqual([
      'Downloading and installing Codex',
      'Checking it works',
    ]);
  });

  it('Node.js says it installs with Homebrew; a sign-in waits on the browser', () => {
    expect(installSteps('node')[0].label).toBe('Installing Node.js with Homebrew');
    expect(installSteps('homebrew').map((s) => s.label)).toEqual([
      'Getting ready to install Homebrew',
      'Downloading and installing Homebrew',
      'Checking it works',
    ]);
    expect(installSteps('claude_auth').map((s) => s.phase)).toEqual([
      'download',
      'browser',
      'check',
    ]);
  });

  it('each step is done, current or still to come', () => {
    const [download, install, check] = installSteps('claude');
    expect(stepState(download, 'install')).toBe('done');
    expect(stepState(install, 'install')).toBe('current');
    expect(stepState(check, 'install')).toBe('todo');
  });
});

describe('phaseFromOutput', () => {
  it('our own "Downloading the … installer" echo is still the download', () => {
    expect(phaseFromOutput('claude', 'Downloading the Claude Code installer…\r\n')).toBe(
      'download'
    );
    expect(phaseFromOutput('claude', 'Downloading the Claude Code installer…\n###### 100%')).toBe(
      'download'
    );
  });

  it('moves to installing only on what the installer itself printed', () => {
    expect(phaseFromOutput('claude', 'Downloading…\nSetting up Claude Code...')).toBe('install');
    expect(
      phaseFromOutput('homebrew', 'Password:\n==> Downloading and installing Homebrew...')
    ).toBe('install');
    // "Installing Codex via npm…" is our echo, and npm is one step anyway.
    expect(phaseFromOutput('codex', 'Installing Codex via npm…\nadded 1 package in 4s')).toBe(
      'download'
    );
  });

  it('a sign-in is waiting on the browser as soon as the command says anything', () => {
    expect(phaseFromOutput('claude_auth', '')).toBe('download');
    expect(phaseFromOutput('claude_auth', 'Opening browser…\n')).toBe('browser');
  });

  it('never goes back', () => {
    expect(laterPhase('install', 'download')).toBe('install');
    expect(laterPhase('download', 'check')).toBe('check');
  });
});

describe('promptOf', () => {
  it('sees sudo asking for the Mac password, until the installer prints past it', () => {
    expect(promptOf('==> Checking for `sudo` access\r\nPassword:')).toBe('password');
    expect(promptOf('[sudo] password for sam: ')).toBe('password');
    expect(promptOf('Password:\r\n==> This script will install:\r\n')).toBeNull();
  });

  it('sees Homebrew asking for Return, and a sign-in that takes a code', () => {
    expect(promptOf('Press RETURN/ENTER to continue or any other key to abort:')).toBe('enter');
    expect(promptOf('Paste code here if prompted > ')).toBe('code');
  });

  it('calls anything else a question only once it has gone quiet on a prompt', () => {
    const asks = 'Select login method:\r\n ❯ 1. Claude account\r\nChoose one:';
    expect(promptOf(asks, 0)).toBeNull();
    expect(promptOf(asks, QUESTION_QUIET_MS)).toBe('question');
    expect(promptOf('Downloading…\r\n', QUESTION_QUIET_MS)).toBeNull();
  });
});

describe('signInUrlOf', () => {
  it('takes the sign-in link, never a docs link', () => {
    const out =
      'See https://docs.example.com/cli for help\r\nIf the browser didn’t open, visit: https://claude.ai/oauth/authorize?code=true\r\n';
    expect(signInUrlOf(out)).toBe('https://claude.ai/oauth/authorize?code=true');
    expect(signInUrlOf('See https://docs.example.com/cli')).toBeNull();
  });
});

describe('describeFailure', () => {
  it('names each cause a person can fix, with the one fix', () => {
    expect(describeFailure('claude', played('claude', 'network')).kind).toBe('network');
    expect(describeFailure('codex', played('codex', 'network')).kind).toBe('network');
    expect(describeFailure('claude', played('claude', 'disk')).kind).toBe('disk');
    expect(describeFailure('codex', played('codex', 'disk')).kind).toBe('disk');
    expect(describeFailure('codex', played('codex', 'permission')).kind).toBe('permission');
    expect(describeFailure('homebrew', played('homebrew', 'admin')).kind).toBe('admin');
    expect(describeFailure('node', played('node', 'homebrew')).kind).toBe('homebrew');
    expect(describeFailure('codex', 'sh: npm: command not found').kind).toBe('node');
    expect(describeFailure('homebrew', 'Sorry, try again.').kind).toBe('password');
  });

  it('a full disk is a full disk even though the download failed too', () => {
    const f = describeFailure(
      'claude',
      'curl: (23) Failure writing output\nNo space left on device'
    );
    expect(f.kind).toBe('disk');
    expect(f.fix).toMatch(/Free up/);
  });

  it('offline says to check the Mac is online, not to reopen the app', () => {
    const f = describeFailure('claude', 'curl: (6) Could not resolve host: claude.ai');
    expect(f.line).toBe('Couldn’t reach the download server.');
    expect(f.fix).toMatch(/^Check this Mac is online/);
  });

  it('a clean exit the app can’t confirm is said as that, never as success', () => {
    expect(describeFailure('codex', 'added 1 package', { exitedClean: true })).toMatchObject({
      kind: 'unverified',
      line: 'It finished, but Codex isn’t showing up on this Mac.',
    });
    expect(describeFailure('claude_auth', '', { exitedClean: true }).line).toMatch(/signed in/);
  });

  it('anything else is what the process actually said', () => {
    expect(describeFailure('codex', 'npm failed')).toMatchObject({
      kind: 'unknown',
      line: 'npm failed',
    });
  });

  it('a sign-in the CLI insists is done names who it is signed in as', () => {
    expect(describeFailure('claude_auth', 'Logged in as sam@example.com').kind).toBe('signed_in');
  });
});

describe('mockScript', () => {
  it('a mock sign-in never links to a real sign-in page', () => {
    expect(signInUrlOf(played('claude_auth'))).toMatch(/^https:\/\/example\.com\//);
  });

  it('Homebrew’s mock waits on the password and on Return, as the real one does', () => {
    const waits = mockScript('homebrew').lines.filter((l) => l.waitsForInput);
    expect(waits.map((l) => promptOf(l.text))).toEqual(['password', 'enter']);
  });
});
