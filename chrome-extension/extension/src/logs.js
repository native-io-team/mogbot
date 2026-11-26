// What an agent's tab said in its console and which requests it made, for
// `read_console` and `read_network`. Recorded from Chrome's DevTools events
// (`chrome.debugger.onEvent`) once the extension drives the tab: the
// `Runtime` and `Network` domains are switched on when it attaches
// (`cdp.js`, `ON_ATTACH`), by the extension itself; the app can't send
// either domain's commands.
//
// Kept in the service worker's memory only, capped per tab, and dropped when
// the tab closes or its agent lets it go. A service worker Chrome restarted
// starts empty.

/** Entries kept per tab, for each kind. */
export const MAX_ENTRIES = 200;
/** The longest console text kept. */
export const MAX_TEXT = 1000;
/** The longest address kept. */
export const MAX_URL = 2000;
/** The most entries one read returns. */
export const MAX_READ = 200;

const KINDS = ['console', 'network'];

function cut(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** One console argument as text: its value, else Chrome's description. */
function argText(a) {
  if (!a || typeof a !== 'object') return '';
  if ('value' in a) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  if (a.unserializableValue) return String(a.unserializableValue);
  return String(a.description || a.type || '');
}

/** Where a console line came from: `url:line`. */
function whereOf(frames) {
  const f = frames && Array.isArray(frames.callFrames) ? frames.callFrames[0] : null;
  if (!f || !f.url) return '';
  return cut(`${f.url}:${(f.lineNumber ?? 0) + 1}`, 300);
}

export class Logs {
  constructor(now = () => Date.now()) {
    this.now = now;
    /** @type {Map<number, {since: number, seq: number, console: object[], network: object[], requests: Map<string, object>}>} */
    this.tabs = new Map();
  }

  /** Start keeping a tab's logs (it was just attached). */
  start(tabId) {
    if (!this.tabs.has(tabId)) {
      this.tabs.set(tabId, {
        since: this.now(),
        seq: 0,
        console: [],
        network: [],
        requests: new Map(),
      });
    }
  }

  /** The tab closed, or its agent let it go. */
  drop(tabId) {
    this.tabs.delete(tabId);
  }

  push(tab, kind, entry) {
    const list = tab[kind];
    tab.seq += 1;
    list.push({ seq: tab.seq, t: this.now(), ...entry });
    while (list.length > MAX_ENTRIES) {
      const gone = list.shift();
      if (kind === 'network' && tab.requests.get(gone.id) === gone) tab.requests.delete(gone.id);
    }
    return list[list.length - 1];
  }

  /** One DevTools event from `chrome.debugger.onEvent`. */
  record(tabId, method, params) {
    const tab = this.tabs.get(tabId);
    if (!tab || !params || typeof params !== 'object') return;
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const args = Array.isArray(params.args) ? params.args : [];
        const level = params.type === 'warning' ? 'warn' : String(params.type || 'log');
        this.push(tab, 'console', {
          level,
          text: cut(args.map(argText).join(' '), MAX_TEXT),
          source: whereOf(params.stackTrace),
        });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {};
        const text = (d.exception && d.exception.description) || d.text || 'Uncaught exception';
        const source = d.url ? cut(`${d.url}:${(d.lineNumber ?? 0) + 1}`, 300) : '';
        this.push(tab, 'console', { level: 'error', text: cut(text, MAX_TEXT), source });
        return;
      }
      case 'Network.requestWillBeSent': {
        const id = String(params.requestId || '');
        // A redirect: the hop before it ends with the redirect's status.
        const before = tab.requests.get(id);
        if (before && params.redirectResponse) before.status = params.redirectResponse.status;
        const req = params.request || {};
        const entry = this.push(tab, 'network', {
          id,
          method: String(req.method || 'GET'),
          url: cut(req.url, MAX_URL),
          type: String(params.type || ''),
        });
        tab.requests.set(id, entry);
        return;
      }
      case 'Network.responseReceived': {
        const entry = tab.requests.get(String(params.requestId || ''));
        if (entry && params.response) entry.status = params.response.status;
        return;
      }
      case 'Network.loadingFailed': {
        const entry = tab.requests.get(String(params.requestId || ''));
        if (entry) {
          entry.failed = cut(params.errorText || 'failed', 200);
          if (params.canceled) entry.failed = 'canceled';
        }
        return;
      }
      default:
    }
  }

  /**
   * What a tab recorded of one kind: the newest `limit`, after `since` (a
   * `seq` from an earlier read), oldest first.
   */
  read(tabId, kind, since, limit) {
    if (!KINDS.includes(kind)) return null;
    const tab = this.tabs.get(tabId);
    if (!tab) return { since: null, entries: [] };
    const after = Number.isInteger(since) ? since : 0;
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_READ) : MAX_READ;
    const all = tab[kind].filter((e) => e.seq > after);
    // The request id is Chrome's own bookkeeping: not handed on.
    const entries = all
      .slice(-n)
      .map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'id')));
    return { since: tab.since, entries, more: all.length - entries.length };
  }
}
