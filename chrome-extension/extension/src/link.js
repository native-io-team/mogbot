// The link to the app: one native messaging port to the app's host, kept
// open while Chrome runs, and opened again with a backoff when it closes.
//
// MV3 service workers stop when idle, but an open native port keeps one
// running (Chrome 105+), and a one-minute alarm starts it again if Chrome
// stopped it anyway (or the app wasn't running): the worker wakes, the
// alarm's listener connects, and the link is back.

import { HOST_NAME, PROTOCOL, fail, hello, ok, parseRequest } from './protocol.js';

/** Waits between reconnects while the worker is awake, then the alarm. */
export const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
export const ALARM = 'dashbot-link';

/**
 * What the link is doing, for the popup and the badge.
 * - `connecting`, `connected`
 * - `app_not_running`: the host started but the app isn't open
 * - `no_host`: Chrome couldn't start the host (the app hasn't set it up)
 * - `update_needed`: this extension and the app speak different versions
 * - `refused`: the host and the app didn't trust each other
 * - `stopped`: the app turned the link off
 */
export class Link {
  /**
   * @param {typeof chrome} chrome
   * @param {{ handle: (op: object) => Promise<unknown>, profile: () => Promise<{profileId: string, profileLabel: string}>, onState?: (s: string) => void, setTimer?: typeof setTimeout }} deps
   */
  constructor(chrome, deps) {
    this.chrome = chrome;
    this.deps = deps;
    this.port = null;
    this.state = 'connecting';
    this.attempt = 0;
    this.timer = null;
    this.lastError = '';
    this.setTimer = deps.setTimer || ((f, ms) => setTimeout(f, ms));
  }

  setState(s, detail = '') {
    this.state = s;
    this.lastError = detail;
    if (this.deps.onState) this.deps.onState(s);
  }

  /** Open the port, unless it's open. */
  async connect() {
    if (this.port) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.setState('connecting');
    let port;
    try {
      port = this.chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      this.setState('no_host', String((e && e.message) || e));
      this.retry();
      return;
    }
    this.port = port;
    port.onMessage.addListener((msg) => {
      void this.received(port, msg);
    });
    port.onDisconnect.addListener(() => {
      const err = this.chrome.runtime.lastError;
      // A port this link already let go of (replaced, or disconnected on
      // purpose): nothing to do.
      if (this.port !== port) return;
      this.port = null;
      const message = (err && err.message) || '';
      if (/not found|forbidden/i.test(message)) this.setState('no_host', message);
      else if (this.state === 'connected' || this.state === 'connecting')
        this.setState('connecting', message);
      this.retry();
    });
    const { profileId, profileLabel } = await this.deps.profile();
    this.post(
      port,
      hello({
        version: this.chrome.runtime.getManifest().version,
        profileId,
        profileLabel,
        userAgent: (globalThis.navigator && globalThis.navigator.userAgent) || '',
      })
    );
  }

  post(port, msg) {
    try {
      port.postMessage(msg);
    } catch {
      // The port closed under us; onDisconnect follows.
    }
  }

  /** Send an event to the app, if the link is up. */
  event(msg) {
    if (this.port && this.state === 'connected') this.post(this.port, msg);
  }

  /** Try again later: quickly while the worker is awake, then the alarm. */
  retry() {
    if (this.port || this.timer || this.state === 'update_needed' || this.state === 'stopped')
      return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.connect();
    }, wait);
  }

  /** The alarm fired: reconnect if down, whatever happened before. */
  wake() {
    if (this.state === 'stopped' || this.state === 'update_needed') this.state = 'connecting';
    void this.connect();
  }

  disconnect(state) {
    const port = this.port;
    this.port = null;
    this.setState(state);
    if (port) {
      try {
        port.disconnect();
      } catch {
        // Already closed.
      }
    }
  }

  async received(port, msg) {
    if (!msg || typeof msg !== 'object' || port !== this.port) return;
    switch (msg.t) {
      case 'welcome':
        if (msg.v !== PROTOCOL) {
          this.disconnect('update_needed');
          return;
        }
        this.attempt = 0;
        this.setState('connected');
        return;
      case 'unavailable':
        // The host is about to exit; the alarm brings the link back once
        // the app is open.
        this.setState(msg.reason === 'app_not_running' ? 'app_not_running' : 'refused', msg.reason);
        this.attempt = BACKOFF_MS.length;
        return;
      case 'bye':
        if (msg.reason === 'version') this.disconnect('update_needed');
        else if (msg.reason === 'off') this.disconnect('stopped');
        else if (msg.reason === 'quit') {
          // The app is quitting: back as soon as it is (the slow end of
          // the backoff, then the alarm).
          this.attempt = BACKOFF_MS.length - 1;
          this.setState('app_not_running');
        } else if (msg.reason === 'replaced') {
          // A newer link from this same profile took over: this port is the
          // stale one. Nothing to do.
          if (this.port === port) this.port = null;
        }
        return;
      case 'req': {
        let id = Number.isInteger(msg.id) ? msg.id : 0;
        try {
          const req = parseRequest(msg);
          id = req.id;
          const result = await this.deps.handle(req.op);
          this.post(port, ok(id, result));
        } catch (e) {
          this.post(port, fail(id, e));
        }
        return;
      }
      default:
    }
  }
}
