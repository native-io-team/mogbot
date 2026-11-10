/**
 * installProgress against what the real installers and sign-ins print.
 *
 * The transcripts in `__fixtures__/install/` are built from the installers'
 * and CLIs' own source (each file's `%%` lines say which), read without
 * running them. Notation: `\e` ESC, `\a` BEL, `\r` carriage return, `⏸` the
 * process stops there and waits, `%%` a note. Newlines become the PTY's \r\n.
 */
import { describe, expect, it } from 'vitest';
import {
  describeFailure,
  mockScript,
  phaseFromOutput,
  promptOf,
  QUESTION_QUIET_MS,
  signInUrlOf,
  type InstallPrompt,
} from './installProgress';
import claudeInstallRaw from './__fixtures__/install/claude-install.txt?raw';
import claudeOfflineRaw from './__fixtures__/install/claude-install-offline.txt?raw';
import claudeBlockedRaw from './__fixtures__/install/claude-install-blocked.txt?raw';
import claudeAuthRaw from './__fixtures__/install/claude-auth-login.txt?raw';
import claudeAuthPasteRaw from './__fixtures__/install/claude-auth-login-paste.txt?raw';
import codexInstallRaw from './__fixtures__/install/codex-install.txt?raw';
import codexEaccesRaw from './__fixtures__/install/codex-install-eacces.txt?raw';
import codexLoginRaw from './__fixtures__/install/codex-login.txt?raw';
import brewInstallRaw from './__fixtures__/install/homebrew-install.txt?raw';
import brewPopupRaw from './__fixtures__/install/homebrew-clt-popup.txt?raw';
import brewPasswordRaw from './__fixtures__/install/homebrew-wrong-password.txt?raw';
import brewOfflineRaw from './__fixtures__/install/homebrew-offline-fetch.txt?raw';

interface Transcript {
  /** Everything it printed. */
  full: string;
  /** What was on screen each time it stopped to wait. */
  waits: string[];
  /** The output as it stood at the end of each line, in order. */
  lineEnds: string[];
}

function load(raw: string): Transcript {
  const body = raw
    .split('\n')
    .filter((line) => !line.startsWith('%%'))
    .join('\n')
    .replace(/\\e/g, '\x1b')
    .replace(/\\a/g, '\x07')
    .replace(/\\r/g, '\r')
    .replace(/\n/g, '\r\n');
  const parts = body.split('⏸');
  const waits = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join(''));
  const full = parts.join('');
  const lineEnds: string[] = [];
  for (let i = full.indexOf('\n'); i !== -1; i = full.indexOf('\n', i + 1)) {
    lineEnds.push(full.slice(0, i + 1));
  }
  return { full, waits, lineEnds };
}

/** The output up to the end of the first line containing `needle`. */
function upTo(t: Transcript, needle: string): string {
  const at = t.full.indexOf(needle);
  if (at === -1) throw new Error(`not in the transcript: ${needle}`);
  const end = t.full.indexOf('\n', at);
  return end === -1 ? t.full : t.full.slice(0, end + 1);
}

/** Every prompt seen at a line's end, however long it then sat quiet. */
const promptsAtLineEnds = (t: Transcript) =>
  new Set(t.lineEnds.map((out) => promptOf(out, QUESTION_QUIET_MS)).filter(Boolean));

const claudeInstall = load(claudeInstallRaw);
const brewInstall = load(brewInstallRaw);
const brewPopup = load(brewPopupRaw);
const brewPassword = load(brewPasswordRaw);
const codexInstall = load(codexInstallRaw);
const claudeAuth = load(claudeAuthRaw);
const claudeAuthPaste = load(claudeAuthPasteRaw);
const codexLogin = load(codexLoginRaw);

describe('Claude Code install (install.sh, then `claude install`)', () => {
  it('stays on the download through our echo, curl’s bar and the silent binary fetch', () => {
    expect(phaseFromOutput('claude', upTo(claudeInstall, 'installer…'))).toBe('download');
    expect(phaseFromOutput('claude', upTo(claudeInstall, '100.0%'))).toBe('download');
  });

  it('moves to installing on install.sh’s own "Setting up Claude Code..."', () => {
    expect(phaseFromOutput('claude', upTo(claudeInstall, 'Setting up Claude Code'))).toBe(
      'install'
    );
    // and stays there to the end: the check is the app's, after exit
    expect(phaseFromOutput('claude', claudeInstall.full)).toBe('install');
  });

  it('never asks anything, even through the Ink screen’s redraws', () => {
    expect(promptsAtLineEnds(claudeInstall).size).toBe(0);
    expect(promptOf(claudeInstall.full, QUESTION_QUIET_MS)).toBeNull();
  });

  it('a failure says which kind, from the script’s own words', () => {
    expect(describeFailure('claude', load(claudeOfflineRaw).full).kind).toBe('network');
    expect(describeFailure('claude', load(claudeBlockedRaw).full).kind).toBe('network');
  });
});

describe('Homebrew install (install.sh)', () => {
  it('asks for the Mac password, then for Return, before it downloads anything', () => {
    const [password, enter] = brewInstall.waits;
    expect(promptOf(password)).toBe('password');
    expect(phaseFromOutput('homebrew', password)).toBe('download');
    expect(promptOf(enter)).toBe('enter');
    expect(phaseFromOutput('homebrew', enter)).toBe('download');
  });

  it('Apple’s Command Line Tools installing is not Homebrew installing', () => {
    const tools = upTo(brewInstall, 'Installing Command Line Tools for Xcode-16.4');
    expect(phaseFromOutput('homebrew', tools)).toBe('download');
    expect(phaseFromOutput('homebrew', upTo(brewInstall, 'Done with Command Line Tools'))).toBe(
      'download'
    );
  });

  it('moves on at "Downloading and installing Homebrew...", and stays there to the end', () => {
    expect(phaseFromOutput('homebrew', upTo(brewInstall, 'Downloading and installing'))).toBe(
      'install'
    );
    expect(phaseFromOutput('homebrew', brewInstall.full)).toBe('install');
  });

  it('nothing else it prints is taken for a question, or for the password again', () => {
    const seen = promptsAtLineEnds(brewInstall);
    expect(seen.has('password')).toBe(false);
    expect(seen.has('question')).toBe(false);
  });

  it('the Command Line Tools window it waits on is a "press any key"', () => {
    const [enter, key] = brewPopup.waits;
    expect(promptOf(enter)).toBe('enter');
    expect(promptOf(key)).toBe<InstallPrompt>('key');
    expect(phaseFromOutput('homebrew', key)).toBe('download');
  });

  it('a mistyped password asks again; three is the password, not admin rights', () => {
    for (const wait of brewPassword.waits) expect(promptOf(wait)).toBe('password');
    expect(promptOf(upTo(brewPassword, 'Sorry, try again.'))).toBeNull();
    expect(describeFailure('homebrew', brewPassword.full).kind).toBe('password');
  });

  it('a git fetch that gives up is the network', () => {
    const offline = load(brewOfflineRaw);
    expect(phaseFromOutput('homebrew', offline.full)).toBe('install');
    expect(describeFailure('homebrew', offline.full).kind).toBe('network');
  });
});

describe('Codex install (npm install -g)', () => {
  it('is one step: npm prints its --force warning, a spinner, then the summary', () => {
    for (const out of codexInstall.lineEnds) expect(phaseFromOutput('codex', out)).toBe('download');
    expect(promptsAtLineEnds(codexInstall).size).toBe(0);
  });

  it('EACCES is a permission problem, with the Codex fix', () => {
    const f = describeFailure('codex', load(codexEaccesRaw).full);
    expect(f.kind).toBe('permission');
    expect(f.fix).toMatch(/Claude Code installs without one/);
  });
});

describe('Claude Code sign-in (`claude auth login`)', () => {
  it('is waiting on the browser from its first line', () => {
    expect(phaseFromOutput('claude_auth', '')).toBe('download');
    expect(phaseFromOutput('claude_auth', upTo(claudeAuth, 'Opening browser'))).toBe('browser');
  });

  it('offers the code field while its prompt is open, and the sign-in link through OSC 8', () => {
    const [waiting] = claudeAuth.waits;
    expect(promptOf(waiting)).toBe('code');
    expect(signInUrlOf(waiting)).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  });

  it('"Login successful." on the prompt’s line closes the field', () => {
    expect(promptOf(claudeAuth.full, QUESTION_QUIET_MS)).toBeNull();
  });

  it('when the browser can’t hand it back, it asks for the code, and again after a bad one', () => {
    const [first, again] = claudeAuthPaste.waits;
    expect(promptOf(first)).toBe('code');
    expect(promptOf(again)).toBe('code');
    expect(signInUrlOf(first)).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    expect(promptOf(claudeAuthPaste.full, QUESTION_QUIET_MS)).toBeNull();
  });
});

describe('Codex sign-in (`codex login`)', () => {
  it('waits on the browser with nothing to type, and links the sign-in page, not localhost', () => {
    const [waiting] = codexLogin.waits;
    expect(phaseFromOutput('codex_auth', waiting)).toBe('browser');
    expect(promptOf(waiting, QUESTION_QUIET_MS)).toBeNull();
    expect(signInUrlOf(waiting)).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  });
});

describe('the mock runs say what the real ones do', () => {
  const play = (itemId: string) =>
    mockScript(itemId)
      .lines.map((l) => (l.waitsForInput || l.open ? l.text : `${l.text}\r\n`))
      .join('');

  it('reach the same step as the transcripts', () => {
    expect(phaseFromOutput('claude', play('claude'))).toBe('install');
    expect(phaseFromOutput('homebrew', play('homebrew'))).toBe('install');
    expect(phaseFromOutput('codex', play('codex'))).toBe('download');
  });

  it('the Claude sign-in leaves its code prompt open; Codex’s asks for nothing', () => {
    const claude = mockScript('claude_auth').lines;
    const open = claude.findIndex((l) => l.open);
    const before = claude
      .slice(0, open + 1)
      .map((l) => (l.open ? l.text : `${l.text}\r\n`))
      .join('');
    expect(promptOf(before)).toBe('code');
    expect(promptOf(play('codex_auth'), QUESTION_QUIET_MS)).toBeNull();
    expect(signInUrlOf(play('codex_auth'))).toMatch(/^https:\/\/example\.com\//);
  });
});
