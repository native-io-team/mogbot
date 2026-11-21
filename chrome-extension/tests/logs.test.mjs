// A tab's console and requests (`logs.js`, `tab_logs`): recorded from the
// DevTools events once the extension drives the tab, capped, merged by
// request, only for the agent that opened the tab, and dropped with it.
// Run: node --test chrome-extension/tests/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Cdp, LOGGED_EVENTS, METHODS, ON_ATTACH, vet } from '../extension/src/cdp.js';
import { Logs, MAX_ENTRIES, MAX_TEXT, MAX_URL } from '../extension/src/logs.js';
import { handle } from '../extension/src/ops.js';
import { CODES, OPS } from '../extension/src/protocol.js';
import { Tabs } from '../extension/src/tabs.js';
import { fakeChrome } from './fake-chrome.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));

async function setUp() {
  const { chrome, sent } = fakeChrome();
  const tabs = new Tabs(chrome);
  tabs.listen(() => {});
  const cdp = new Cdp(chrome, tabs);
  cdp.listen(() => {});
  const parts = { tabs, cdp };
  const tab = await handle(
    { kind: 'tabs_open', agent: 'ana', label: 'Ana', url: 'https://example.com/' },
    parts
  );
  const fire = (method, params) =>
    chrome.debugger.onEvent.fire({ tabId: tab.tab_id }, method, params);
  const logs = (log, extra = {}) =>
    handle({ kind: 'tab_logs', agent: 'ana', tab_id: tab.tab_id, log, ...extra }, parts);
  return { chrome, sent, parts, tab, fire, logs };
}

test('the op is in the protocol, and the domains it needs are the extension’s own', () => {
  assert.ok(OPS.includes('tab_logs'));
  assert.ok(ON_ATTACH.includes('Runtime.enable') && ON_ATTACH.includes('Network.enable'));
  // The app still can't send either domain's commands.
  for (const m of [
    'Runtime.enable',
    'Network.enable',
    'Network.getResponseBody',
    'Network.getCookies',
  ]) {
    assert.ok(!METHODS.has(m));
    assert.throws(
      () => vet(m, {}),
      (e) => e.code === CODES.notAllowed
    );
  }
  for (const e of LOGGED_EVENTS) assert.ok(!METHODS.has(e));
});

test('a tab not driven yet is attached on the first read, and says recording starts now', async () => {
  const { sent, fire, logs } = await setUp();
  // Before the extension drives the tab, nothing is kept.
  fire('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'lost' }] });
  const first = await logs('console');
  assert.equal(first.started, true);
  assert.deepEqual(first.entries, []);
  assert.ok(sent.some((s) => s.method === 'Runtime.enable'));
  assert.ok(sent.some((s) => s.method === 'Network.enable'));
  fire('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'kept' }] });
  const second = await logs('console');
  assert.equal(second.started, false);
  assert.deepEqual(
    second.entries.map((e) => e.text),
    ['kept']
  );
});

test('console lines: level, the arguments as text, where, and exceptions as errors', async () => {
  const { fire, logs } = await setUp();
  await logs('console');
  fire('Runtime.consoleAPICalled', {
    type: 'warning',
    args: [
      { type: 'string', value: 'slow' },
      { type: 'number', value: 3 },
      { type: 'object', description: 'Object' },
      { type: 'number', unserializableValue: 'NaN' },
    ],
    stackTrace: { callFrames: [{ url: 'https://example.com/app.js', lineNumber: 11 }] },
  });
  fire('Runtime.exceptionThrown', {
    exceptionDetails: {
      text: 'Uncaught',
      exception: { description: 'TypeError: x is undefined' },
      url: 'https://example.com/app.js',
      lineNumber: 39,
    },
  });
  const got = await logs('console');
  assert.deepEqual(
    got.entries.map(({ level, text, source }) => ({ level, text, source })),
    [
      { level: 'warn', text: 'slow 3 Object NaN', source: 'https://example.com/app.js:12' },
      {
        level: 'error',
        text: 'TypeError: x is undefined',
        source: 'https://example.com/app.js:40',
      },
    ]
  );
  // `since` and `limit`: only what's newer, only the newest.
  const after = await logs('console', { since: got.entries[0].seq });
  assert.equal(after.entries.length, 1);
  assert.equal((await logs('console', { limit: 1 })).entries[0].level, 'error');
  assert.equal((await logs('console', { limit: 1 })).more, 1);
});

test('requests: method and address, merged with the status, a failure, a redirect', async () => {
  const { fire, logs } = await setUp();
  await logs('network');
  fire('Network.requestWillBeSent', {
    requestId: '1',
    request: { method: 'GET', url: 'https://example.com/' },
    type: 'Document',
  });
  fire('Network.responseReceived', { requestId: '1', response: { status: 200 } });
  fire('Network.requestWillBeSent', {
    requestId: '2',
    request: { method: 'POST', url: 'https://example.com/api' },
  });
  fire('Network.loadingFailed', { requestId: '2', errorText: 'net::ERR_FAILED' });
  fire('Network.requestWillBeSent', {
    requestId: '3',
    request: { method: 'GET', url: 'http://example.com/old' },
  });
  fire('Network.requestWillBeSent', {
    requestId: '3',
    request: { method: 'GET', url: 'https://example.com/new' },
    redirectResponse: { status: 301 },
  });
  fire('Network.responseReceived', { requestId: '3', response: { status: 404 } });
  const got = await logs('network');
  assert.deepEqual(
    got.entries.map(({ method, url, status, failed }) => ({ method, url, status, failed })),
    [
      { method: 'GET', url: 'https://example.com/', status: 200, failed: undefined },
      {
        method: 'POST',
        url: 'https://example.com/api',
        status: undefined,
        failed: 'net::ERR_FAILED',
      },
      { method: 'GET', url: 'http://example.com/old', status: 301, failed: undefined },
      { method: 'GET', url: 'https://example.com/new', status: 404, failed: undefined },
    ]
  );
  // Chrome's request ids stay in the extension.
  assert.ok(got.entries.every((e) => !('id' in e)));
});

test('kept per tab up to a cap, each line cut to size', () => {
  const logs = new Logs();
  logs.start(5);
  for (let i = 0; i < MAX_ENTRIES + 25; i++) {
    logs.record(5, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: `${i}:${'x'.repeat(MAX_TEXT * 2)}` }],
    });
    logs.record(5, 'Network.requestWillBeSent', {
      requestId: String(i),
      request: { method: 'GET', url: `https://example.com/${'y'.repeat(MAX_URL * 2)}` },
    });
  }
  const c = logs.read(5, 'console');
  assert.equal(c.entries.length + c.more, MAX_ENTRIES);
  assert.ok(c.entries[0].text.startsWith('25:'), 'the oldest went first');
  assert.ok(c.entries.every((e) => e.text.length <= MAX_TEXT));
  const n = logs.read(5, 'network');
  assert.equal(n.entries.length + n.more, MAX_ENTRIES);
  assert.ok(n.entries.every((e) => e.url.length <= MAX_URL));
  // A response for a request that fell off the end changes nothing.
  logs.record(5, 'Network.responseReceived', { requestId: '0', response: { status: 200 } });
  assert.ok(logs.read(5, 'network').entries.every((e) => e.status === undefined));
  assert.equal(logs.tabs.get(5).requests.size, MAX_ENTRIES);
  // Another tab's events, or a tab never started, keep nothing.
  logs.record(6, 'Runtime.consoleAPICalled', { type: 'log', args: [] });
  assert.deepEqual(logs.read(6, 'console'), { since: null, entries: [] });
  assert.equal(logs.read(5, 'cookies'), null);
});

test('only the agent that opened the tab reads it; the logs go with the tab', async () => {
  const { chrome, parts, tab, fire, logs } = await setUp();
  await logs('console');
  fire('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }] });
  await assert.rejects(
    handle({ kind: 'tab_logs', agent: 'bo', tab_id: tab.tab_id, log: 'console' }, parts),
    (e) => e.code === CODES.notOwned
  );
  await assert.rejects(logs('cookies'), (e) => e.code === CODES.badRequest);
  assert.ok(parts.cdp.logs.tabs.has(tab.tab_id));
  await chrome.tabs.remove(tab.tab_id);
  await tick();
  assert.ok(!parts.cdp.logs.tabs.has(tab.tab_id), 'dropped when the tab closed');
});

test('letting an agent go drops its tabs’ logs', async () => {
  const { parts, tab, logs } = await setUp();
  await logs('network');
  assert.ok(parts.cdp.logs.tabs.has(tab.tab_id));
  await handle({ kind: 'release', agent: 'ana' }, parts);
  assert.ok(!parts.cdp.logs.tabs.has(tab.tab_id));
});
