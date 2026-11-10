/**
 * Onboarding's installs and sign-ins as a native installer shows them: a few
 * plain steps ("Downloading Claude Code", "Installing", "Checking it works"),
 * moved on only by what the real process prints and by how it exits, and a
 * failure said as the one thing that went wrong with the one fix.
 *
 * Everything here is pure: which steps an item has, which step some output
 * means, whether the process is waiting on the person (a Mac password, a
 * press of Return, a code from the browser), the sign-in link it printed,
 * and what a failure was. The process itself still runs in a real terminal
 * (`OnboardingTerminal`), which the screen keeps under "Show details".
 *
 * Nothing self-certifies: "Checking it works" is the app's own status check
 * (`get_full_setup_status`) after the process exits, never the process's own
 * "success" line.
 *
 * The mock scripts at the end are what `SHIPSTUDIO_FORCE_SETUP` plays instead
 * of a real install, through the same parsing, so the mock mode and the
 * harness exercise every state without touching the Mac.
 *
 * @module lib/installProgress
 */

import { stripAnsi } from './ansi';
import {
  detectAlreadyLoggedIn,
  extractTerminalError,
  isNetworkError,
  isNodeMissingError,
  toVisibleLines,
} from './terminalDiagnostics';
import { alreadySignedInMessage } from '../components/setup/setupFailureMessages';

// ============ Steps ============

/** Where an install or a sign-in is, in order. A run never goes back a phase. */
export const INSTALL_PHASES = ['download', 'install', 'browser', 'check'] as const;
export type InstallPhase = (typeof INSTALL_PHASES)[number];

export interface InstallStep {
  phase: InstallPhase;
  label: string;
}

/** The name a person knows each item by (the setup list calls Homebrew "Package Manager"). */
const PLAIN_NAMES: Record<string, string> = {
  homebrew: 'Homebrew',
  node: 'Node.js',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export const plainName = (itemId: string) =>
  PLAIN_NAMES[itemId.replace(/_auth$/, '')] ?? itemId.replace(/_auth$/, '');

export const isAuthItem = (itemId: string) => itemId.endsWith('_auth');

/**
 * Node.js installs through Homebrew in the background (`install_brew_packages`),
 * which shows nothing until it's done: one honest step, then the check.
 */
export const QUIET_ITEMS = new Set(['node', 'git', 'gh']);

/**
 * npm installs download and install in one go and print nothing that tells
 * the two apart (a bare spinner, then "added 1 package"), so they are one
 * step rather than two that move on a guess.
 */
const NPM_ITEMS = new Set(['codex', 'vercel']);

/** The steps one screen shows. */
export function installSteps(itemId: string): InstallStep[] {
  if (isAuthItem(itemId)) {
    return [
      { phase: 'download', label: 'Opening sign-in in your browser' },
      { phase: 'browser', label: 'Waiting for you to sign in' },
      { phase: 'check', label: 'Checking you’re signed in' },
    ];
  }
  if (QUIET_ITEMS.has(itemId)) {
    return [
      { phase: 'install', label: `Installing ${plainName(itemId)} with Homebrew` },
      { phase: 'check', label: 'Checking it works' },
    ];
  }
  if (NPM_ITEMS.has(itemId)) {
    return [
      { phase: 'download', label: `Downloading and installing ${plainName(itemId)}` },
      { phase: 'check', label: 'Checking it works' },
    ];
  }
  if (itemId === 'homebrew') {
    // Homebrew's installer downloads nothing until after the password, the
    // Return and (on a bare Mac) Apple's Command Line Tools; then one line,
    // "Downloading and installing Homebrew...", covers the rest.
    return [
      { phase: 'download', label: 'Getting ready to install Homebrew' },
      { phase: 'install', label: 'Downloading and installing Homebrew' },
      { phase: 'check', label: 'Checking it works' },
    ];
  }
  return [
    { phase: 'download', label: `Downloading ${plainName(itemId)}` },
    { phase: 'install', label: 'Installing' },
    { phase: 'check', label: 'Checking it works' },
  ];
}

/** The later of two phases: a run never goes back. */
export function laterPhase(a: InstallPhase, b: InstallPhase): InstallPhase {
  return INSTALL_PHASES.indexOf(b) > INSTALL_PHASES.indexOf(a) ? b : a;
}

/** What each step is: done, the one going now, or still to come. */
export function stepState(step: InstallStep, phase: InstallPhase): 'done' | 'current' | 'todo' {
  const at = INSTALL_PHASES.indexOf(phase);
  const mine = INSTALL_PHASES.indexOf(step.phase);
  return mine < at ? 'done' : mine === at ? 'current' : 'todo';
}

/**
 * The lines the app's own install commands print first, so the download is
 * never silent (`TERMINAL_COMMANDS`). They are ours, not the installer's, so
 * "Installing Codex via npm…" is no evidence the install has started.
 */
const OWN_ECHO = /^(Downloading the .+ installer|Installing .+ via npm)/i;

/**
 * Lines an installer prints once it has the files and is putting them in
 * place. Claude Code's install.sh downloads the binary silently (`curl -fsSL`),
 * then prints "Setting up Claude Code..." and runs `claude install`, which
 * prints "Installing Claude Code native build …" and "Claude Code successfully
 * installed!" (transcripts in `__fixtures__/install/`).
 */
const INSTALLING_SIGNAL =
  /setting up|\binstalling\b|successfully installed|installation (complete|successful)/i;

/**
 * Homebrew's own "downloading now" line. Nothing before it is a download:
 * "==> Installing Command Line Tools for Xcode…" comes first on a bare Mac and
 * is Apple's tools, not Homebrew, so the generic "installing" never applies.
 */
const HOMEBREW_DOWNLOADING = /^==> Downloading and installing Homebrew/;

/** The phase a run's output shows it has reached (before it exits). */
export function phaseFromOutput(itemId: string, output: string): InstallPhase {
  const lines = toVisibleLines(output).filter((line) => !OWN_ECHO.test(line));
  if (isAuthItem(itemId)) {
    // Anything at all from the sign-in command means the browser has been sent.
    return lines.length > 0 ? 'browser' : 'download';
  }
  if (QUIET_ITEMS.has(itemId)) return 'install';
  if (NPM_ITEMS.has(itemId)) return 'download';
  if (itemId === 'homebrew') {
    return lines.some((line) => HOMEBREW_DOWNLOADING.test(line)) ? 'install' : 'download';
  }
  return lines.some((line) => INSTALLING_SIGNAL.test(line)) ? 'install' : 'download';
}

// ============ Waiting on the person ============

/**
 * What the process is waiting for, read off its last line:
 * - `password`: sudo's "Password:" (Homebrew's installer)
 * - `enter`: Homebrew's "Press RETURN/ENTER to continue or any other key to abort:"
 * - `key`: Homebrew's "Press any key when the installation has completed.",
 *   once it has opened Apple's Command Line Tools installer window
 * - `code`: a sign-in that offers to take a code pasted from the browser
 *   (`claude auth login`: "Paste code here if prompted > ", or "Paste code
 *   here > " when the browser can't hand the sign-in back; and after
 *   "Invalid code…", which waits for another)
 * - `question`: something else that ends like a prompt and has gone quiet
 *   (the caller says how long it's been quiet); the screen opens the details
 *   so it can be answered
 */
export type InstallPrompt = 'password' | 'enter' | 'key' | 'code' | 'question';

/** Quiet this long on a line that ends like a prompt, and it is asking something. */
export const QUESTION_QUIET_MS = 4000;

export function promptOf(output: string, quietMs = 0): InstallPrompt | null {
  const lines = toVisibleLines(output);
  const last = lines[lines.length - 1];
  if (!last) return null;
  // A prompt waits on its own line: once the process prints past it, it was answered.
  const endsOpen = !/\n\s*$/.test(stripAnsi(output));
  if (/\bpassword\b[^:]*:\s*$/i.test(last) && endsOpen) return 'password';
  if (/press (return|enter)/i.test(last)) return 'enter';
  if (/press any key when/i.test(last)) return 'key';
  // The code prompt stays on the line it was printed on: whatever comes next
  // (the echoed code, or "Login successful." once the browser answered)
  // lands after it, so it only counts while the line still ends in it.
  if (/paste (the )?code[^>]*>\s*$|^invalid code\b|not from this sign-in/i.test(last)) {
    return 'code';
  }
  if (endsOpen && quietMs >= QUESTION_QUIET_MS && /[?:>❯]\s*$/.test(last)) return 'question';
  return null;
}

/**
 * The sign-in page a sign-in command printed ("If the browser didn't open,
 * visit: https://…"), so the screen can open it again. Only a link that
 * looks like a sign-in, never a docs link that happened to be printed.
 */
export function signInUrlOf(output: string): string | null {
  const text = toVisibleLines(output).join('\n');
  const urls = text.match(/https:\/\/[^\s"'<>]+/g) ?? [];
  const signIn = urls.filter((u) => /oauth|authori[sz]e|login|sign-?in|device|auth\b/i.test(u));
  return signIn[signIn.length - 1] ?? null;
}

// ============ Failures ============

export type InstallFailureKind =
  | 'network'
  | 'disk'
  | 'permission'
  | 'admin'
  | 'password'
  | 'homebrew'
  | 'license'
  | 'node'
  | 'signed_in'
  | 'unverified'
  | 'unknown';

export interface InstallFailure {
  kind: InstallFailureKind;
  /** What went wrong, in a sentence. */
  line: string;
  /** The one thing to do. Left out when Try again is the whole answer. */
  fix?: string;
}

const NOT_ADMIN =
  /does not have admin privileges|requires administrator access|not an administrator|need sudo access|not in the sudoers|insufficient permissions to install homebrew/i;
/** sudo giving up. Homebrew then aborts with "Insufficient permissions", which isn't the cause. */
const PASSWORD_GAVE_UP = /incorrect password attempts/i;
const XCODE_LICENSE = /not agreed to the xcode license/i;
const DISK_FULL =
  /\bENOSPC\b|no space left on device|not enough (free )?(disk )?space|disk (is )?full/i;
const NO_HOMEBREW = /homebrew is needed|brew: (command )?not found|failed to run brew/i;
const BAD_PASSWORD = /sorry, try again|incorrect password attempts/i;
const NO_PERMISSION =
  /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|not writable/i;
/**
 * curl's exit 23 is a failed write on this Mac, not the network. Claude
 * Code's installer says "download service is unreachable" when it gets no
 * version back; Homebrew gives up on `git fetch` with "Failed 5 times doing".
 */
const NETWORKISH =
  /network|timed? ?out|offline|couldn.t reach|could not reach|ssl|certificate|curl: \((?!23\))\d+\)|download service is unreachable|failed \d+ times doing: \S*git fetch/i;

/**
 * What a failed run was, from everything it printed (or the error the app
 * got back). Order matters: the most specific cause first, so "no space
 * left" is never reported as a network problem because curl also failed.
 */
export function describeFailure(
  itemId: string,
  output: string,
  opts: { exitedClean?: boolean } = {}
): InstallFailure {
  const text = stripAnsi(output);
  const auth = isAuthItem(itemId);
  const name = plainName(itemId);

  if (PASSWORD_GAVE_UP.test(text)) {
    return {
      kind: 'password',
      line: 'The Mac password wasn’t accepted.',
      fix: 'Press Try again, and use the password you log in to this Mac with.',
    };
  }
  if (NOT_ADMIN.test(text)) {
    return {
      kind: 'admin',
      line: 'Your Mac account isn’t allowed to install apps.',
      fix: 'Sign in to an administrator account on this Mac, or ask whoever manages it to make yours one (System Settings → Users & Groups), then press Try again.',
    };
  }
  if (DISK_FULL.test(text)) {
    return {
      kind: 'disk',
      line: 'This Mac is out of disk space.',
      fix: 'Free up at least 1 GB (empty the Bin, or delete large downloads), then press Try again.',
    };
  }
  if (NO_HOMEBREW.test(text)) {
    return {
      kind: 'homebrew',
      line: `Homebrew isn’t on this Mac, and ${name} installs with it.`,
      fix: 'Press Try again: it installs Homebrew first.',
    };
  }
  if (XCODE_LICENSE.test(text)) {
    return {
      kind: 'license',
      line: 'Apple’s developer tools are waiting for you to accept their licence.',
      fix: 'Open Xcode once and agree to the licence, then press Try again.',
    };
  }
  if (isNodeMissingError(text)) {
    return {
      kind: 'node',
      line: `Node.js isn’t on this Mac, and ${name} needs it.`,
      fix: 'Press Try again: it installs Node.js first.',
    };
  }
  if (BAD_PASSWORD.test(text)) {
    return {
      kind: 'password',
      line: 'The Mac password wasn’t accepted.',
      fix: 'Press Try again, and use the password you log in to this Mac with.',
    };
  }
  if (NO_PERMISSION.test(text)) {
    return {
      kind: 'permission',
      line: 'This Mac didn’t let the install write the files it needs.',
      fix:
        itemId === 'codex'
          ? 'Press Try again. If it happens twice, this Mac needs an administrator to allow it; Claude Code installs without one.'
          : 'Press Try again. If it happens twice, ask whoever manages this Mac to allow installs.',
    };
  }
  if (isNetworkError(text) || NETWORKISH.test(text)) {
    return {
      kind: 'network',
      line: auth ? 'Couldn’t reach the sign-in server.' : 'Couldn’t reach the download server.',
      fix: 'Check this Mac is online (open any website), then press Try again.',
    };
  }
  if (auth) {
    const already = detectAlreadyLoggedIn(text);
    if (already) {
      return { kind: 'signed_in', line: alreadySignedInMessage(itemId, already.identity) };
    }
  }
  if (opts.exitedClean) {
    return {
      kind: 'unverified',
      line: auth
        ? 'Sign-in finished, but this Mac doesn’t show you signed in.'
        : `It finished, but ${name} isn’t showing up on this Mac.`,
      fix: 'Press Try again. If it happens twice, quit and reopen the app, then try once more.',
    };
  }
  return {
    kind: 'unknown',
    line: extractTerminalError(text) ?? 'It stopped before it finished.',
    fix: 'Press Try again. If it fails twice, quit and reopen the app, then try once more.',
  };
}

// ============ Mock scripts (SHIPSTUDIO_FORCE_SETUP) ============

/** A failure the mock plays once, so each one can be seen and recovered from. */
export const MOCK_FAILURES = [
  'network',
  'disk',
  'permission',
  'admin',
  'homebrew',
  'signin',
] as const;
export type MockFailure = (typeof MOCK_FAILURES)[number];

export const isMockFailure = (s: unknown): s is MockFailure =>
  typeof s === 'string' && (MOCK_FAILURES as readonly string[]).includes(s);

export interface MockLine {
  /** Milliseconds after the previous line (or the start). */
  after: number;
  text: string;
  /** Waits here until the person answers (a password, Return). */
  waitsForInput?: boolean;
  /**
   * Printed with no line break and doesn't wait: a prompt the process
   * leaves up while it carries on (`claude auth login`'s "Paste code here if
   * prompted > ", answered by the browser instead).
   */
  open?: boolean;
}

export interface MockScript {
  lines: MockLine[];
  exitCode: number;
}

/** Fictional links: a mock never sends anyone to a real sign-in page. */
const MOCK_SIGN_IN = 'https://example.com/oauth/authorize?demo=1';

/**
 * What a mock run prints, as the real one would, line by line, with each
 * phase long enough to see. `failure` replaces the ending with that failure
 * when this item can have it (only Homebrew's installer asks for admin;
 * only Node.js installs with Homebrew).
 */
export function mockScript(itemId: string, failure: MockFailure | null = null): MockScript {
  const ok = (lines: MockLine[]): MockScript => ({ lines, exitCode: 0 });
  const fail = (lines: MockLine[]): MockScript => ({ lines, exitCode: 1 });

  // The lines below are the real installers' and CLIs' own words (see
  // `__fixtures__/install/` for where each comes from); only the links,
  // versions and timings are made up.
  if (itemId === 'codex_auth') {
    const opening: MockLine[] = [
      { after: 400, text: 'Starting local login server on http://localhost:1455.' },
      { after: 50, text: 'If your browser did not open, navigate to this URL to authenticate:' },
      { after: 50, text: ' ' },
      { after: 50, text: MOCK_SIGN_IN },
      { after: 50, text: ' ' },
      {
        after: 50,
        text: 'On a remote or headless machine? Use `codex login --device-auth` instead.',
      },
    ];
    if (failure === 'network' || failure === 'signin') {
      return fail([
        ...opening,
        {
          after: 2400,
          text:
            failure === 'network'
              ? 'Error logging in: error sending request for url (https://auth.example.com/oauth/token): getaddrinfo ENOTFOUND auth.example.com'
              : 'Error logging in: Login was not completed',
        },
      ]);
    }
    return ok([...opening, { after: 3200, text: 'Successfully logged in' }]);
  }

  if (isAuthItem(itemId)) {
    // `claude auth login`, which leaves its code prompt up while it waits for
    // the browser to hand the sign-in back.
    const opening: MockLine[] = [
      { after: 400, text: 'Opening browser to sign in…' },
      { after: 50, text: `If the browser didn't open, visit: ${MOCK_SIGN_IN}` },
      { after: 50, text: 'Paste code here if prompted > ', open: true },
    ];
    if (failure === 'network' || failure === 'signin') {
      return fail([
        ...opening,
        {
          after: 2400,
          text:
            failure === 'network'
              ? 'OAuth login failed: getaddrinfo ENOTFOUND auth.example.com'
              : 'Login interrupted.',
        },
      ]);
    }
    return ok([...opening, { after: 3200, text: 'Login successful.' }]);
  }

  if (itemId === 'node') {
    if (failure === 'homebrew') {
      return fail([
        {
          after: 1400,
          text: 'Homebrew is needed to install this. Install Homebrew from the Package Manager step first, then try again.',
        },
      ]);
    }
    return ok([{ after: 2600, text: '' }]);
  }

  if (itemId === 'homebrew') {
    if (failure === 'admin') {
      // The app's own check, before it downloads anything (`TERMINAL_COMMANDS.homebrew`).
      return fail([
        { after: 900, text: 'Error: Homebrew requires administrator access to install.' },
        { after: 50, text: 'Your macOS user account (you) does not have admin privileges.' },
      ]);
    }
    return ok([
      { after: 200, text: 'Downloading the Homebrew installer…' },
      { after: 900, text: '==> Checking for `sudo` access (which may request your password)...' },
      { after: 300, text: 'Password:', waitsForInput: true },
      { after: 400, text: '==> This script will install:' },
      { after: 50, text: '/opt/homebrew/bin/brew' },
      { after: 50, text: '/opt/homebrew/share/doc/homebrew' },
      { after: 50, text: '/opt/homebrew' },
      { after: 50, text: '==> The following new directories will be created:' },
      { after: 50, text: '/opt/homebrew/bin' },
      {
        after: 200,
        text: 'Press RETURN/ENTER to continue or any other key to abort:',
        waitsForInput: true,
      },
      {
        after: 300,
        text: '==> /usr/bin/sudo /usr/bin/install -d -o root -g wheel -m 0755 /opt/homebrew',
      },
      { after: 600, text: '==> Downloading and installing Homebrew...' },
      { after: 900, text: 'remote: Enumerating objects: 312456, done.' },
      { after: 1400, text: '==> Installation successful!' },
      { after: 100, text: '==> Next steps:' },
      { after: 50, text: '- Run brew help to get started' },
    ]);
  }

  const npm = itemId === 'codex';
  // Claude Code: our echo, curl's bar for install.sh itself, then a silence
  // while install.sh fetches the binary with `curl -fsSL`, then its own line.
  const download: MockLine[] = npm
    ? [
        { after: 200, text: 'Installing Codex via npm…' },
        { after: 300, text: 'npm warn using --force Recommended protections disabled.' },
      ]
    : [
        { after: 200, text: `Downloading the ${plainName(itemId)} installer…` },
        { after: 500, text: '######################################################## 100.0%' },
      ];
  // npm prints nothing between its warning and its summary (a spinner only),
  // which is why an npm install is one step.
  const settingUp: MockLine = { after: 2400, text: `Setting up ${plainName(itemId)}...` };
  const installing: MockLine[] = npm
    ? []
    : itemId === 'claude'
      ? [
          settingUp,
          { after: 300, text: 'Checking installation status...' },
          { after: 600, text: 'Installing Claude Code native build 2.1.0...' },
          { after: 900, text: 'Setting up launcher and shell integration...' },
        ]
      : [settingUp];

  switch (failure) {
    case 'network':
      return fail([
        download[0],
        {
          after: 1600,
          text: npm
            ? 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/@openai%2fcodex failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org'
            : 'curl: (6) Could not resolve host: claude.ai',
        },
      ]);
    case 'disk':
      return fail([
        ...download,
        ...installing,
        {
          after: 1200,
          text: npm
            ? 'npm error code ENOSPC\nnpm error syscall write\nnpm error nospc ENOSPC: no space left on device, write'
            : '✗ Installation failed\nENOSPC: no space left on device, write',
        },
      ]);
    case 'permission':
      return fail([
        // install.sh makes its download folder before fetching anything.
        ...download,
        {
          after: 1200,
          text: npm
            ? "npm error code EACCES\nnpm error syscall mkdir\nnpm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@openai'"
            : 'mkdir: /Users/you/.claude/downloads: Permission denied',
        },
      ]);
    default:
      return ok([
        ...download,
        ...installing,
        {
          after: 1600,
          text: npm ? 'added 2 packages in 9s' : `✔ ${plainName(itemId)} successfully installed!`,
        },
        ...(npm ? [] : [{ after: 300, text: '✅ Installation complete!' }]),
      ]);
  }
}
