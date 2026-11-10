/**
 * One headless Chrome, owned for exactly as long as the process that asked for it.
 *
 * Every measuring tool here drives Chrome over CDP, and each used to do its own
 * launching: a fixed debugging port, a fixed profile directory, and
 * `chrome.kill()` in a `finally`. That combination leaks, and the leak compounds
 * in a way that is invisible until someone looks at `ps`:
 *
 *   1. A run is interrupted — and it routinely is, because a four-width run
 *      takes minutes and an agent's shell call is killed long before that.
 *      `finally` never executes, so Chrome is reparented to init and stays.
 *   2. The next run spawns Chrome on the same fixed port. It cannot bind, and
 *      it cannot take the profile lock either, so it exits immediately.
 *   3. The wait loop then asks the port whether a browser is there. The orphan
 *      answers `200`, so the run proceeds against a browser it did not start
 *      and cannot account for — one whose profile is hours stale.
 *   4. Its `finally` kills the child that already died. The orphan is never
 *      killed, collects another handful of tabs, and step 2 repeats.
 *
 * Measured on one machine after a normal day: three orphans aged 11–13 hours,
 * 46 processes, 5.0 GB resident, one holding 20 tabs from four different
 * projects — all funnelled into it by step 3.
 *
 * So this module fixes each link rather than the symptom:
 *
 * - **Never adopt.** A port that already answers belongs to someone else; move
 *   to the next one. Adopting is what made a leak look like a working tool.
 * - **A port and a profile per run**, so two runs — or two worktrees — cannot
 *   collide in the first place.
 * - **Own the whole tree.** Chrome's renderers are children of Chrome; killing
 *   the parent alone can leave them. The browser gets its own process group and
 *   the group is what gets signalled.
 * - **More than one way out.** `finally` cannot survive SIGKILL, so cleanup is
 *   also on `exit`, on SIGINT/SIGTERM/SIGHUP, and on an uncaught throw.
 * - **Sweep on the way in.** Anything still running from a previous run of the
 *   same tool is ours to reap; it is identified by the profile prefix we set,
 *   so nothing else on the machine can match.
 * - **A ceiling.** `maxMs` closes the browser (and ends the run) if the run
 *   outlives it, so a hung capture can't keep a browser alive overnight.
 *
 * Why this matters beyond memory: macOS hands a link the user clicks (an
 * app's "Sign in" opening the default browser) to a *running* Chrome, and a
 * headless one counts. A leaked headless Chrome swallowed real sign-in pages
 * that way, so the user saw nothing open. A profile of our own under TMPDIR,
 * and never outliving the run, is what keeps our browsers out of that.
 *
 * @module scripts/headless-chrome
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** First Chrome-alike found. Chromium is a fine stand-in; the CDP is the same. */
export const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Marks a profile directory as ours, and is what the sweep matches on. */
const PROFILE_TAG = 'shipstudio-cdp';

/**
 * Is anything listening here?
 *
 * Deliberately a bind test rather than an HTTP request. Asking the port whether
 * it speaks CDP is the question that got this wrong before — a stale browser
 * answers it correctly. The only useful question is whether the port is free.
 */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function findFreePort(basePort, span = 40) {
  for (let port = basePort; port < basePort + span; port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(
    `No free debugging port in ${basePort}–${basePort + span - 1}. ` +
      `Something is holding them: try \`lsof -nP -iTCP -sTCP:LISTEN | grep ${basePort}\`.`
  );
}

/**
 * Kill browsers left behind by earlier runs of this same tool.
 *
 * Matching is on the profile path, which carries both our tag and the tool's
 * name, so this can only ever match a browser this module started. Chrome
 * instances a person opened, and other tools' instances, do not match.
 */
/**
 * Which `ps -Ao pid=,ppid=,command=` lines are browsers this tool started and
 * nobody owns any more: our profile marker (or an older one in `legacy`), a
 * headless browser process, and orphaned (parent is init). Pure, for tests.
 */
export function orphanPids(psOutput, tool, legacy = [], selfPid = process.pid) {
  const marker = `${PROFILE_TAG}-${tool}-`;
  const ours = (line) => line.includes(marker) || legacy.some((re) => re.test(line));
  const pids = [];
  for (const line of psOutput.split('\n')) {
    if (!ours(line) || !line.includes('--headless')) continue;
    const [pid, ppid] = line.trim().split(/\s+/, 2).map(Number);
    // Only the browser process itself (it holds the --user-data-dir flag) and
    // only once orphaned: a live run's parent is still around to clean up.
    if (!pid || ppid !== 1 || pid === selfPid) continue;
    pids.push(pid);
  }
  return pids;
}

export function sweepOrphans(tool, legacy = []) {
  let out = '';
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' });
  } catch {
    return 0; // No ps, no sweep. Not worth failing a run over.
  }
  let killed = 0;
  for (const pid of orphanPids(out, tool, legacy)) {
    try {
      process.kill(pid, 'SIGKILL');
      killed += 1;
    } catch {
      /* already gone */
    }
  }
  return killed;
}

/**
 * Launch a headless Chrome and hand back the port it actually got.
 *
 * @param {object} options
 * @param {string} options.tool      Short name; picks the profile and the sweep scope.
 * @param {number} options.basePort  Preferred port. Taken ports are skipped, not adopted.
 * @param {string[]} [options.args]  Extra Chrome flags.
 * @param {number} [options.scale]   Device scale factor (default 1).
 * @param {boolean} [options.disableGpu] Pass --disable-gpu (default true).
 * @param {number} [options.maxMs]   Close the browser and end the run after this long.
 * @param {RegExp[]} [options.legacy] Profiles an older version of the tool used, swept too.
 * @returns {Promise<{port: number, close: () => void, swept: number, profile: string}>}
 */
export async function launchChrome({
  tool,
  basePort,
  attempt = 0,
  args = [],
  scale = 1,
  disableGpu = true,
  maxMs,
  legacy = [],
}) {
  if (!CHROME) {
    throw new Error(
      'No Chrome or Chromium found. Install Google Chrome, or point the tool at a Chromium build.'
    );
  }

  const swept = sweepOrphans(tool, legacy);
  const port = await findFreePort(basePort);
  const profile = path.join(os.tmpdir(), `${PROFILE_TAG}-${tool}-${port}-${process.pid}`);

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--hide-scrollbars',
      `--force-device-scale-factor=${scale}`,
      ...(disableGpu ? ['--disable-gpu'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      ...args,
    ],
    // Its own process group, so one signal reaches every renderer. Without
    // this, killing the browser can leave its children behind — which is half
    // of how 46 stray processes accumulate.
    { stdio: 'ignore', detached: true }
  );

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      // Negative pid = the whole group. TERM first so Chrome can unlock its
      // profile; KILL shortly after for the case where it will not go.
      process.kill(-chrome.pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-chrome.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2000).unref?.();
    } catch {
      /* already gone */
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* a locked profile is not worth failing over; the sweep gets it later */
    }
  };

  // `finally` is the happy path. These are the others: a SIGKILL to *this*
  // process still leaves the browser, but every signal we can observe, and
  // every normal or exceptional exit, now takes the browser with it.
  process.once('exit', close);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      close();
      process.exit(130);
    });
  }
  process.once('uncaughtException', (err) => {
    close();
    throw err;
  });
  process.once('unhandledRejection', (err) => {
    close();
    throw err;
  });
  let ceiling;
  if (maxMs) {
    ceiling = setTimeout(() => {
      console.error(
        `[${tool}] still running after ${Math.round(maxMs / 1000)}s; closing Chrome and stopping.`
      );
      close();
      process.exit(124);
    }, maxMs);
    ceiling.unref?.();
  }

  await waitForCdp(port);
  // Two runs started at the same moment both find the same port free, and one
  // Chrome gets 127.0.0.1 while the other settles for [::1]. Both then answer
  // on "the port", and both runs drive the first browser: two captures in one
  // browser share localStorage, so a `--theme dark` run came back half light.
  // Only a browser in our own process group may be the one we talk to.
  if (!listensInGroup(port, chrome.pid)) {
    clearTimeout(ceiling);
    close();
    if (attempt >= 4) {
      throw new Error(`Another browser took debugging port ${port} as ours started; giving up.`);
    }
    return launchChrome({
      tool,
      basePort: port + 1,
      attempt: attempt + 1,
      args,
      scale,
      disableGpu,
      maxMs,
      legacy,
    });
  }
  return { port, close, swept, profile };
}

/**
 * Is the process listening on 127.0.0.1:port one of ours (process group
 * `group`)? Best effort: without lsof, or when it cannot tell, says yes.
 */
function listensInGroup(port, group) {
  let pids;
  try {
    pids = execFileSync('lsof', ['-t', '-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return true;
  }
  if (pids.length === 0) return true;
  return pids.some((pid) => {
    try {
      const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', pid], { encoding: 'utf8' }).trim();
      return Number(pgid) === group;
    } catch {
      return false;
    }
  });
}

/** Wait for the browser we just started to answer on its own port. */
async function waitForCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`Chrome did not open a debugging port on ${port} within 20s.`);
    }
    await sleep(250);
  }
}
