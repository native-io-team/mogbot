// A small stand-in for the parts of `chrome.*` the extension uses, enough
// to drive its modules from `node --test`.

function listeners() {
  const fns = [];
  return {
    addListener: (f) => fns.push(f),
    removeListener: (f) => {
      const i = fns.indexOf(f);
      if (i >= 0) fns.splice(i, 1);
    },
    fire: (...args) => fns.slice().forEach((f) => f(...args)),
    count: () => fns.length,
  };
}

export function fakeChrome() {
  const session = {};
  const local = {};
  const tabs = new Map();
  const windows = new Map();
  let nextId = 100;
  const sent = [];
  const attached = new Set();
  const chrome = {
    runtime: {
      id: 'acpipahophpoekcmokoejnkooedofagk',
      lastError: undefined,
      getManifest: () => ({ version: '0.1.0' }),
      ports: [],
      connectNative(name) {
        const port = {
          name,
          posted: [],
          onMessage: listeners(),
          onDisconnect: listeners(),
          postMessage(m) {
            port.posted.push(m);
          },
          disconnect() {
            port.closed = true;
          },
        };
        chrome.runtime.ports.push(port);
        return port;
      },
    },
    storage: {
      session: {
        get: async (k) => ({ [k]: session[k] }),
        set: async (o) => Object.assign(session, JSON.parse(JSON.stringify(o))),
      },
      local: {
        get: async (ks) => Object.fromEntries(ks.map((k) => [k, local[k]])),
        set: async (o) => Object.assign(local, o),
      },
    },
    tabs: {
      onRemoved: listeners(),
      onUpdated: listeners(),
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        return { ...t };
      },
      async create({ windowId, url, active }) {
        const t = {
          id: nextId++,
          windowId,
          url,
          title: 'Page',
          active: !!active,
          status: 'complete',
        };
        tabs.set(t.id, t);
        return { ...t };
      },
      async remove(id) {
        tabs.delete(id);
        chrome.tabs.onRemoved.fire(id);
      },
      async update(id, props) {
        const t = tabs.get(id);
        Object.assign(t, props);
        return { ...t };
      },
      async group() {
        return 7;
      },
    },
    tabGroups: {
      get: async () => ({ windowId: 1 }),
      update: async () => ({}),
    },
    windows: {
      onRemoved: listeners(),
      async get(id) {
        if (!windows.has(id)) throw new Error('No window');
        return windows.get(id);
      },
      async create({ url }) {
        const w = { id: 1 };
        windows.set(1, w);
        const t = {
          id: nextId++,
          windowId: 1,
          url,
          title: 'Page',
          active: true,
          status: 'complete',
        };
        tabs.set(t.id, t);
        return { id: 1, tabs: [{ ...t }] };
      },
    },
    debugger: {
      onDetach: listeners(),
      async getTargets() {
        return [];
      },
      async attach({ tabId }) {
        attached.add(tabId);
      },
      async detach({ tabId }) {
        attached.delete(tabId);
      },
      async sendCommand({ tabId }, method, params) {
        sent.push({ tabId, method, params });
        return { ok: method };
      },
    },
  };
  return { chrome, tabs, sent, attached, session, local };
}
