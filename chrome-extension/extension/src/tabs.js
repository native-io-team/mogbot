// The agents' tabs: which tab belongs to which agent, the window they open
// in, and each agent's tab group. Kept in `chrome.storage.session`, so a
// service worker that Chrome stopped and started again still knows; gone
// when Chrome quits, like the tabs themselves.
//
// The app keeps its own list too. This one is the second wall: no request
// can reach a tab its agent didn't open here.

import { CODES, ExtError, event, isWebUrl } from './protocol.js';

const KEY = 'agentTabs';
/** Tab group colours Chrome accepts. */
const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export class Tabs {
  /** @param {typeof chrome} chrome */
  constructor(chrome) {
    this.chrome = chrome;
    /** @type {{tabs: Record<string, {agent: string, label: string}>, windowId: number|null, groups: Record<string, number>}} */
    this.state = { tabs: {}, windowId: null, groups: {} };
    this.ready = this.load();
    this.onEvent = () => {};
  }

  async load() {
    try {
      const got = await this.chrome.storage.session.get(KEY);
      if (got && got[KEY]) this.state = { tabs: {}, windowId: null, groups: {}, ...got[KEY] };
    } catch {
      // A fresh state is right when there's nothing stored.
    }
  }

  async save() {
    await this.chrome.storage.session.set({ [KEY]: this.state });
  }

  /** Start listening to Chrome's tab events. `onEvent` gets protocol events. */
  listen(onEvent) {
    this.onEvent = onEvent;
    this.chrome.tabs.onRemoved.addListener((tabId) => {
      void this.removed(tabId);
    });
    this.chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
      void this.updated(tabId, change, tab);
    });
    this.chrome.windows.onRemoved.addListener((windowId) => {
      if (windowId === this.state.windowId) {
        this.state.windowId = null;
        this.state.groups = {};
        void this.save();
      }
    });
  }

  async removed(tabId) {
    await this.ready;
    const owned = this.state.tabs[tabId];
    if (!owned) return;
    delete this.state.tabs[tabId];
    await this.save();
    this.onEvent(event('tab_closed', { tab_id: tabId, agent: owned.agent }));
  }

  async updated(tabId, change, tab) {
    await this.ready;
    const owned = this.state.tabs[tabId];
    if (!owned || !(change.url || change.status === 'complete' || change.title)) return;
    this.onEvent(
      event('tab_updated', {
        tab_id: tabId,
        agent: owned.agent,
        url: tab.url || '',
        title: tab.title || '',
      })
    );
  }

  /** The agent owns the tab, and Chrome still has it. */
  async owned(agent, tabId) {
    await this.ready;
    if (typeof agent !== 'string' || !agent) throw new ExtError(CODES.badRequest, 'no agent');
    const owned = this.state.tabs[tabId];
    if (!owned) throw new ExtError(CODES.notOwned, 'not a tab an agent opened');
    if (owned.agent !== agent) throw new ExtError(CODES.notOwned, 'another agent’s tab');
    try {
      return await this.chrome.tabs.get(tabId);
    } catch {
      delete this.state.tabs[tabId];
      await this.save();
      throw new ExtError(CODES.noTab, 'the tab is gone');
    }
  }

  info(tab, agent) {
    return {
      tab_id: tab.id,
      window_id: tab.windowId,
      url: tab.url || tab.pendingUrl || '',
      title: tab.title || '',
      active: !!tab.active,
      status: tab.status || '',
      agent,
    };
  }

  /** Every agent tab Chrome still has. */
  async list() {
    await this.ready;
    const out = [];
    for (const [id, owned] of Object.entries(this.state.tabs)) {
      try {
        const tab = await this.chrome.tabs.get(Number(id));
        out.push(this.info(tab, owned.agent));
      } catch {
        delete this.state.tabs[id];
      }
    }
    await this.save();
    return out;
  }

  /** The agents' own window, made when there isn't one. */
  async window(url) {
    if (this.state.windowId != null) {
      try {
        await this.chrome.windows.get(this.state.windowId);
        return { windowId: this.state.windowId, tab: null };
      } catch {
        this.state.windowId = null;
        this.state.groups = {};
      }
    }
    // Unfocused, so it doesn't take the user's typing; normal, so Chrome
    // paints it (a minimised window can't be read or pictured).
    const w = await this.chrome.windows.create({ url, focused: false, type: 'normal' });
    this.state.windowId = w.id;
    return { windowId: w.id, tab: w.tabs && w.tabs[0] };
  }

  /** Wait until Chrome says the tab has loaded (or `ms` passes). */
  loaded(tabId, ms = 15000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      };
      const onUpdated = (id, change) => {
        if (id === tabId && change.status === 'complete') finish();
      };
      const timer = setTimeout(finish, ms);
      this.chrome.tabs.onUpdated.addListener(onUpdated);
      this.chrome.tabs.get(tabId).then(
        (t) => {
          if (t.status === 'complete' && !t.pendingUrl && t.url !== 'about:blank') finish();
        },
        () => finish()
      );
    });
  }

  /** A new tab for `agent`, in its own group in the agents' window. */
  async open(agent, label, url, color) {
    await this.ready;
    if (typeof agent !== 'string' || !agent) throw new ExtError(CODES.badRequest, 'no agent');
    if (!isWebUrl(url)) throw new ExtError(CODES.badRequest, 'only http and https pages open');
    const tab = await this.opening(() => this.create(url));
    this.state.tabs[tab.id] = { agent, label: String(label || '').slice(0, 40) };
    await this.save();
    await this.group(agent, label, tab.id, tab.windowId, color);
    // The first load runs with nothing attached; driving starts after it.
    await this.loaded(tab.id);
    return this.info(await this.chrome.tabs.get(tab.id), agent);
  }

  async create(url) {
    const { windowId, tab: first } = await this.window(url);
    return first || (await this.chrome.tabs.create({ windowId, url, active: true }));
  }

  /** One window-or-tab creation at a time, so two agents opening at once
   * don't each make an agents' window. */
  opening(f) {
    const run = (this.queue || Promise.resolve()).then(f, f);
    this.queue = run.catch(() => {});
    return run;
  }

  async group(agent, label, tabId, windowId, color) {
    try {
      let groupId = this.state.groups[agent];
      if (groupId != null) {
        try {
          const g = await this.chrome.tabGroups.get(groupId);
          if (g.windowId !== windowId) groupId = null;
        } catch {
          groupId = null;
        }
      }
      if (groupId == null) {
        groupId = await this.chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
        await this.chrome.tabGroups.update(groupId, {
          title: String(label || 'Agent').slice(0, 40),
          color: COLORS.includes(color) ? color : 'grey',
        });
        this.state.groups[agent] = groupId;
        await this.save();
      } else {
        await this.chrome.tabs.group({ tabIds: [tabId], groupId });
      }
    } catch {
      // A tab outside a group still works; the group is only a label.
    }
  }

  async get(agent, tabId) {
    return this.info(await this.owned(agent, tabId), agent);
  }

  async close(agent, tabId) {
    await this.owned(agent, tabId);
    await this.chrome.tabs.remove(tabId);
    delete this.state.tabs[tabId];
    await this.save();
    return null;
  }

  /** Make the tab the shown one of its window: Chrome paints only that. */
  async focus(agent, tabId) {
    await this.owned(agent, tabId);
    const tab = await this.chrome.tabs.update(tabId, { active: true });
    return this.info(tab, agent);
  }

  /** Close every tab `agent` opened. */
  async release(agent) {
    await this.ready;
    const ids = Object.entries(this.state.tabs)
      .filter(([, o]) => o.agent === agent)
      .map(([id]) => Number(id));
    for (const id of ids) {
      try {
        await this.chrome.tabs.remove(id);
      } catch {
        // Already gone.
      }
      delete this.state.tabs[id];
    }
    delete this.state.groups[agent];
    await this.save();
    return { closed: ids.length };
  }
}
