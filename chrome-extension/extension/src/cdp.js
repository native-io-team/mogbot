// Driving an agent's tab: Chrome's DevTools protocol through
// `chrome.debugger`, limited to the commands the app's page logic sends
// (`src-tauri/src/agent_browser/page.rs`, `METHODS` and `EXPRESSIONS`; a
// Rust test holds this file to that list).
//
// While the extension drives any tab Chrome shows its own bar, "Dashbot
// started debugging this browser". Pressing Cancel there stops every
// agent's driving for a while (`PAUSE_MS`): the user said stop.

import { CODES, ExtError, event, isWebUrl } from './protocol.js';

/** The CDP commands the app may send. Nothing else is relayed. */
export const METHODS = new Set([
  'Accessibility.getFullAXTree',
  'DOM.describeNode',
  'DOM.getBoxModel',
  'DOM.resolveNode',
  'DOM.scrollIntoViewIfNeeded',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Runtime.callFunctionOn',
  'Runtime.evaluate',
]);

/** Sent by the extension itself when it starts driving a tab. */
export const ON_ATTACH = ['Page.enable', 'DOM.enable', 'Accessibility.enable'];

/** The only expressions the app evaluates in a page: the app's own. */
export const EXPRESSIONS = new Set([
  /* FOCUSED_FIELD_JS */ "(() => { let e = document.activeElement; for (let i = 0; e; i++) { if (i > 32) return 'unknown'; if (e.shadowRoot && e.shadowRoot.activeElement) { e = e.shadowRoot.activeElement; continue; } const tag = (e.tagName || '').toUpperCase(); if (tag === 'IFRAME' || tag === 'FRAME') { let d = null; try { d = e.contentDocument; } catch (_) { return 'unknown'; } if (!d) return 'unknown'; e = d.activeElement; continue; } break; } if (!e || (e.tagName || '').toUpperCase() !== 'INPUT') return 'plain'; const t = (e.type || '').toLowerCase(); const a = (e.autocomplete || '').toLowerCase(); return (t === 'password' || a.includes('one-time-code') || a.includes('current-password') || a.includes('new-password')) ? 'secret' : 'plain'; })()",
  /* TEXT_JS */ "document.body ? document.body.innerText : ''",
  /* READY_JS */ 'document.readyState',
  /* VISIBILITY_JS */ 'document.visibilityState',
  /* SCROLL_UP_JS */ 'window.scrollBy(0, -120)',
  /* SCROLL_DOWN_JS */ 'window.scrollBy(0, 120)',
  /* SCROLL_LEFT_JS */ 'window.scrollBy(-120, 0)',
  /* SCROLL_RIGHT_JS */ 'window.scrollBy(120, 0)',
]);

/**
 * The only functions the app calls on a page's node (`Runtime.callFunctionOn`),
 * with numbers as their only arguments: the app's own.
 */
export const FUNCTIONS = new Set([
  /* SCROLL_WITHIN_FN */ "function (dx, dy) { let e = this && this.nodeType === 1 ? this : this && this.parentElement; for (let i = 0; e && i < 64; i++) { if (e.nodeType === 1 && e !== document.body && e !== document.documentElement) { const s = getComputedStyle(e); const y = dy !== 0 && /(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight; const x = dx !== 0 && /(auto|scroll|overlay)/.test(s.overflowX) && e.scrollWidth > e.clientWidth; if (x || y) { const t = e.scrollTop, l = e.scrollLeft; e.scrollBy({ left: dx, top: dy, behavior: 'instant' }); return e.scrollTop !== t || e.scrollLeft !== l ? 'moved' : 'end'; } } const r = e.getRootNode && e.getRootNode(); e = e.parentElement || (r && r.host) || null; } return 'none'; }",
]);

/** How long the user's Cancel on Chrome's bar holds. */
export const PAUSE_MS = 5 * 60 * 1000;

const PROTOCOL_VERSION = '1.3';

/** Pages Chrome doesn't let extensions drive. */
export function protectedUrl(u) {
  const s = String(u || '');
  return (
    !/^https?:/i.test(s) ||
    /^https:\/\/chromewebstore\.google\.com\//i.test(s) ||
    /^https:\/\/chrome\.google\.com\/webstore/i.test(s)
  );
}

/**
 * Check one command before it's sent, and narrow its parameters to what
 * the app's page logic uses. Throws `not_allowed` for anything else.
 */
export function vet(method, params) {
  if (!METHODS.has(method))
    throw new ExtError(CODES.notAllowed, `${String(method).slice(0, 60)} isn't allowed`);
  const p = params && typeof params === 'object' ? params : {};
  if (method === 'Runtime.evaluate') {
    if (!EXPRESSIONS.has(p.expression))
      throw new ExtError(CODES.notAllowed, 'only the app’s own expressions run');
    return { expression: p.expression, returnByValue: true, silent: true };
  }
  if (method === 'Runtime.callFunctionOn') {
    if (!FUNCTIONS.has(p.functionDeclaration))
      throw new ExtError(CODES.notAllowed, 'only the app’s own functions run');
    const args = Array.isArray(p.arguments) ? p.arguments : [];
    if (
      typeof p.objectId !== 'string' ||
      args.length > 4 ||
      !args.every((a) => a && typeof a.value === 'number' && Number.isFinite(a.value))
    )
      throw new ExtError(CODES.notAllowed, 'a function call the app never makes');
    return {
      objectId: p.objectId,
      functionDeclaration: p.functionDeclaration,
      arguments: args.map((a) => ({ value: a.value })),
      returnByValue: true,
      silent: true,
    };
  }
  if (method === 'DOM.resolveNode') {
    if (!Number.isInteger(p.backendNodeId))
      throw new ExtError(CODES.notAllowed, 'a node the app never names');
    return { backendNodeId: p.backendNodeId };
  }
  if (method === 'Page.navigate') {
    if (!isWebUrl(p.url)) throw new ExtError(CODES.notAllowed, 'only http and https pages open');
    return { url: String(p.url) };
  }
  return p;
}

export class Cdp {
  /**
   * @param {typeof chrome} chrome
   * @param {import('./tabs.js').Tabs} tabs
   */
  constructor(chrome, tabs) {
    this.chrome = chrome;
    this.tabs = tabs;
    /** Tabs this extension is attached to. */
    this.attached = new Set();
    /**
     * Tabs with an input event (a click, a key) Chrome hasn't answered yet.
     * Chrome answers input only once the tab paints, so one sent to a tab
     * it isn't painting waits; anything sent after it would queue behind it
     * and land late, after the app was told it failed. So nothing is.
     */
    this.inputs = new Set();
    this.pausedUntil = 0;
    this.onEvent = () => {};
  }

  listen(onEvent) {
    this.onEvent = onEvent;
    this.chrome.debugger.onDetach.addListener((source, reason) => {
      void this.detached(source.tabId, reason);
    });
  }

  async detached(tabId, reason) {
    this.attached.delete(tabId);
    this.inputs.delete(tabId);
    if (reason === 'canceled_by_user') this.pausedUntil = Date.now() + PAUSE_MS;
    await this.tabs.ready;
    const owned = this.tabs.state.tabs[tabId];
    if (owned)
      this.onEvent(
        event('debugger_detached', { tab_id: tabId, agent: owned.agent, reason: String(reason) })
      );
  }

  /** Attached already, by this extension (a restarted service worker forgets). */
  async ours(tabId) {
    if (this.attached.has(tabId)) return true;
    try {
      const targets = await this.chrome.debugger.getTargets();
      const t = targets.find((x) => x.tabId === tabId);
      if (t && t.attached && t.extensionId === this.chrome.runtime.id) {
        this.attached.add(tabId);
        return true;
      }
    } catch {
      // Not known: attach and see.
    }
    return false;
  }

  async attach(tab) {
    if (Date.now() < this.pausedUntil) {
      throw new ExtError(
        CODES.attachFailed,
        'the user pressed Cancel on Chrome’s “debugging this browser” bar a moment ago; ask them before trying again'
      );
    }
    if (protectedUrl(tab.url || tab.pendingUrl)) {
      throw new ExtError(CODES.protected, 'Chrome doesn’t let extensions use this page');
    }
    if (await this.ours(tab.id)) return;
    try {
      await this.chrome.debugger.attach({ tabId: tab.id }, PROTOCOL_VERSION);
    } catch (e) {
      throw new ExtError(CODES.attachFailed, String((e && e.message) || e));
    }
    this.attached.add(tab.id);
    for (const m of ON_ATTACH) {
      try {
        await this.chrome.debugger.sendCommand({ tabId: tab.id }, m, {});
      } catch {
        // A domain that won't enable still leaves the rest usable.
      }
    }
  }

  /** One allowed command on one of `agent`'s tabs. */
  async send(agent, tabId, method, params) {
    const clean = vet(method, params);
    const tab = await this.tabs.owned(agent, tabId);
    const input = method.startsWith('Input.');
    if (input && this.inputs.has(tabId)) {
      throw new ExtError(
        CODES.busy,
        'Chrome hasn’t answered the last input event on this tab; nothing more was sent'
      );
    }
    await this.attach(tab);
    if (input) this.inputs.add(tabId);
    try {
      const r = await this.chrome.debugger.sendCommand({ tabId }, method, clean);
      return r === undefined ? {} : r;
    } catch (e) {
      throw new ExtError(CODES.cdp, String((e && e.message) || e));
    } finally {
      if (input) this.inputs.delete(tabId);
    }
  }

  /** Stop driving `agent`'s tabs. */
  async release(agent) {
    await this.tabs.ready;
    for (const [id, o] of Object.entries(this.tabs.state.tabs)) {
      if (o.agent !== agent) continue;
      const tabId = Number(id);
      if (!this.attached.has(tabId)) continue;
      try {
        await this.chrome.debugger.detach({ tabId });
      } catch {
        // Already detached.
      }
      this.attached.delete(tabId);
    }
  }
}
