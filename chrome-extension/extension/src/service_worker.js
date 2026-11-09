// The extension's service worker: the link to the app, the agents' tabs,
// and driving them. Every listener is registered at the top level, as MV3
// requires, so a worker Chrome restarts for an event hears it.

import { Cdp } from './cdp.js';
import { ALARM, Link } from './link.js';
import { handle } from './ops.js';
import { Tabs } from './tabs.js';

const tabs = new Tabs(chrome);
const cdp = new Cdp(chrome, tabs);

/** This Chrome profile's id (made once), and the name the user gave it. */
async function profile() {
  const got = await chrome.storage.local.get(['profileId', 'profileLabel']);
  let profileId = got.profileId;
  if (!profileId) {
    profileId = crypto.randomUUID();
    await chrome.storage.local.set({ profileId });
  }
  return { profileId, profileLabel: got.profileLabel || '' };
}

const BADGE = {
  connected: '',
  connecting: '…',
  app_not_running: 'off',
  no_host: '!',
  update_needed: '!',
  refused: '!',
  stopped: 'off',
};

function onState(state) {
  try {
    void chrome.action.setBadgeText({ text: BADGE[state] ?? '' });
    void chrome.action.setBadgeBackgroundColor({ color: '#444444' });
  } catch {
    // The badge is a nicety.
  }
}

const link = new Link(chrome, {
  handle: (op) => handle(op, { tabs, cdp }),
  profile,
  onState,
});

// For a look from DevTools (the service worker's console): the link's state.
globalThis.dashbotLink = link;

tabs.listen((msg) => link.event(msg));
cdp.listen((msg) => link.event(msg));

chrome.runtime.onStartup.addListener(() => link.wake());
chrome.runtime.onInstalled.addListener(() => link.wake());
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) link.wake();
});
void chrome.alarms.create(ALARM, { periodInMinutes: 1 });

// The popup: what the link is doing, the profile's name, reconnect.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg) return false;
  if (msg.type === 'status') {
    void profile().then((p) =>
      reply({
        state: link.state,
        detail: link.lastError,
        label: p.profileLabel,
        agentTabs: Object.keys(tabs.state.tabs).length,
      })
    );
    return true;
  }
  if (msg.type === 'reconnect') {
    link.wake();
    reply({ ok: true });
    return false;
  }
  if (msg.type === 'label') {
    const profileLabel = String(msg.label || '').slice(0, 60);
    void chrome.storage.local.set({ profileLabel }).then(() => {
      // The app learns the new name on the next hello.
      link.disconnect('connecting');
      link.wake();
      reply({ ok: true });
    });
    return true;
  }
  return false;
});

link.wake();
