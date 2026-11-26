// A tab Chrome won't attach the debugger to, because another extension's
// frame is in it: the extension names that extension, reads and scrolls the
// page without the debugger, and refuses clicks and typing.
// Run: node --test chrome-extension/tests/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

import { Cdp, EXPRESSIONS, SCROLL_WITHIN_FN } from '../extension/src/cdp.js';
import {
  EXPRESSIONS as FALLBACK_EXPRESSIONS,
  PAGE,
  foreignFrame,
  inTheWayMessage,
} from '../extension/src/fallback.js';
import { CODES } from '../extension/src/protocol.js';
import { Tabs } from '../extension/src/tabs.js';
import { fakeChrome } from './fake-chrome.mjs';

const OTHER = 'kbfnbcaeplbcioakkpcpgfkobkghlhen';
const THIRD = 'gighmmpiobklfepjocnamgkkbiglidom';
const CHROME_SAYS = 'Cannot access a chrome-extension:// URL of different extension';
const TEXT_JS = "document.body ? document.body.innerText : ''";

/** A page in jsdom, standing in for the tab `executeScript` runs in. */
function page(html) {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Feed</title></head><body>${html}</body></html>`,
    {
      pretendToBeVisual: true,
    }
  );
  const w = dom.window;
  // What jsdom leaves out and Chrome has: innerText, checkVisibility.
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
    configurable: true,
  });
  w.Element.prototype.checkVisibility = function () {
    for (let e = this; e; e = e.parentElement)
      if (w.getComputedStyle(e).display === 'none') return false;
    return true;
  };
  w.scrolled = [];
  w.scrollBy = (x, y) => w.scrolled.push([x, y]);
  globalThis.window = w;
  globalThis.document = w.document;
  globalThis.getComputedStyle = (e) => w.getComputedStyle(e);
  delete globalThis.__mogbotFallback;
  return w;
}

/** An agent's tab in a Chrome whose debugger is kept out by another extension. */
async function blocked() {
  const f = fakeChrome();
  const tabs = new Tabs(f.chrome);
  tabs.listen(() => {});
  const cdp = new Cdp(f.chrome, tabs);
  cdp.listen(() => {});
  const t = await tabs.open('ana', 'Ana', 'https://www.linkedin.com/feed/');
  f.chrome.debugger.attachError = CHROME_SAYS;
  f.chrome.debugger.targets = [
    {
      type: 'other',
      tabId: t.tab_id,
      url: `chrome-extension://${OTHER}/frame.html`,
      attached: false,
    },
    // Another tab's frame, and an extension's own worker: not this tab's.
    { type: 'other', tabId: 999, url: `chrome-extension://${THIRD}/x.html`, attached: false },
    { type: 'worker', url: `chrome-extension://${THIRD}/sw.js`, attached: false },
  ];
  f.chrome.management.installed[OTHER] = { name: 'Grammarly' };
  return { ...f, cdp, tab: t.tab_id };
}

test('Chrome’s refusal is told apart from any other failed attach', () => {
  assert.ok(foreignFrame(new Error(CHROME_SAYS)));
  assert.ok(
    !foreignFrame(new Error('Another debugger is already attached to the tab with id: 4.'))
  );
  assert.ok(!foreignFrame(undefined));
});

test('every expression answered without the debugger is one of the app’s own', () => {
  for (const e of FALLBACK_EXPRESSIONS.keys()) assert.ok(EXPRESSIONS.has(e), e);
  // Asked only before typing, which needs the debugger.
  assert.ok(![...FALLBACK_EXPRESSIONS.keys()].some((e) => e.includes('activeElement')));
});

test('text, load state and page scrolling work without the debugger', async () => {
  const w = page('<main><h1>Hello</h1><p>World</p></main>');
  const { cdp, tab, sent, attached } = await blocked();
  const text = await cdp.send('ana', tab, 'Runtime.evaluate', { expression: TEXT_JS });
  assert.deepEqual(text, { result: { type: 'string', value: 'HelloWorld' } });
  const ready = await cdp.send('ana', tab, 'Runtime.evaluate', {
    expression: 'document.readyState',
  });
  assert.equal(ready.result.value, 'complete');
  await cdp.send('ana', tab, 'Runtime.evaluate', { expression: 'window.scrollBy(0, 120)' });
  assert.deepEqual(w.scrolled, [[0, 120]]);
  // Nothing went through the debugger.
  assert.equal(sent.length, 0);
  assert.equal(attached.size, 0);
});

test('a tree read names the extension in the way, and reads the page like Chrome’s tree', async () => {
  page(`
    <iframe src="chrome-extension://${OTHER}/frame.html"></iframe>
    <nav aria-label="Primary"><a href="/feed">Home</a></nav>
    <main>
      <h2>Start a post</h2>
      <label for="q">Search</label><input id="q" value="ai agents">
      <input type="password" aria-label="Password" value="hunter2">
      <button disabled>Send</button>
      <input type="checkbox" aria-label="Remember" checked>
      <div style="display:none"><button>Hidden</button></div>
      <div aria-hidden="true"><button>Also hidden</button></div>
    </main>`);
  const { cdp, tab, chrome } = await blocked();
  const tree = await cdp.send('ana', tab, 'Accessibility.getFullAXTree', {});
  assert.deepEqual(tree.withoutDebugger.inTheWay, [`“Grammarly” (${OTHER})`]);
  const by = (role, name) =>
    tree.nodes.find((n) => n.role.value === role && (name === undefined || n.name.value === name));
  assert.equal(tree.nodes[0].role.value, 'RootWebArea');
  assert.equal(tree.nodes[0].name.value, 'Feed');
  assert.ok(by('navigation', 'Primary'));
  assert.ok(by('link', 'Home'));
  assert.ok(by('heading', 'Start a post'));
  assert.equal(by('textbox', 'Search').value.value, 'ai agents');
  // A password's value is never read out, and it says it's protected.
  const pw = by('textbox', 'Password');
  assert.equal(pw.value, undefined);
  assert.ok(pw.properties.some((p) => p.name === 'protected' && p.value.value === true));
  assert.ok(by('button', 'Send').properties.some((p) => p.name === 'disabled'));
  assert.ok(
    by('checkbox', 'Remember').properties.some(
      (p) => p.name === 'checked' && p.value.value === 'true'
    )
  );
  assert.equal(by('button', 'Hidden'), undefined);
  assert.equal(by('button', 'Also hidden'), undefined);
  // Every node it names has a negative id, which Chrome never gives.
  const ids = tree.nodes.filter((n) => 'backendDOMNodeId' in n).map((n) => n.backendDOMNodeId);
  assert.ok(ids.length > 0 && ids.every((i) => Number.isInteger(i) && i < 0));
  // Each child points at its parent, and every child id resolves.
  const all = new Set(tree.nodes.map((n) => n.nodeId));
  for (const n of tree.nodes) for (const c of n.childIds) assert.ok(all.has(c));
  // The page's own frame list was asked too (a frame Chrome doesn't list).
  assert.ok(chrome.scripting.calls.some((c) => c.func === 'pageExtensionFrames'));
});

test('open shadow roots are read, and an extension found only in the page is named', async () => {
  const w = page('<div id="host"></div>');
  const root = w.document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = `<button>Compose</button><iframe src="chrome-extension://${THIRD}/a.html"></iframe>`;
  const { cdp, tab, chrome } = await blocked();
  chrome.debugger.targets = [];
  const tree = await cdp.send('ana', tab, 'Accessibility.getFullAXTree', {});
  assert.ok(tree.nodes.some((n) => n.role.value === 'button' && n.name.value === 'Compose'));
  // Not installed here (or not nameable): named by id.
  assert.deepEqual(tree.withoutDebugger.inTheWay, [`an extension with id ${THIRD}`]);
});

test('clicks, typing and screenshots are refused, naming the extension', async () => {
  page('<button>Post</button>');
  const { cdp, tab, sent } = await blocked();
  for (const [method, params] of [
    ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }],
    ['Input.insertText', { text: 'hi' }],
    ['Page.captureScreenshot', {}],
  ]) {
    await assert.rejects(cdp.send('ana', tab, method, params), (e) => {
      assert.equal(e.code, CODES.foreignFrame);
      assert.match(
        e.message,
        /“Grammarly” \(kbfnbcaeplbcioakkpcpgfkobkghlhen\) puts its own frame/
      );
      return true;
    });
  }
  assert.equal(sent.length, 0);
  // Any other failed attach is still just that.
  const other = await blocked();
  other.chrome.debugger.attachError = 'Another debugger is already attached to the tab with id: 4.';
  await assert.rejects(
    other.cdp.send('ana', other.tab, 'Runtime.evaluate', { expression: TEXT_JS }),
    (e) => e.code === CODES.attachFailed
  );
});

test('a ref read without the debugger scrolls its box, and never reaches Chrome', async () => {
  const w = page('<div id="pane" style="overflow-y: auto"><a href="/m/1">Message one</a></div>');
  const pane = w.document.getElementById('pane');
  // jsdom has no layout: give the pane something to scroll.
  Object.defineProperty(pane, 'scrollHeight', { value: 2000 });
  Object.defineProperty(pane, 'clientHeight', { value: 300 });
  pane.scrollBy = ({ top }) => {
    pane.scrollTop += top;
  };
  const { cdp, tab, chrome, sent } = await blocked();
  const tree = await cdp.send('ana', tab, 'Accessibility.getFullAXTree', {});
  const link = tree.nodes.find((n) => n.role.value === 'link');
  const resolved = await cdp.send('ana', tab, 'DOM.resolveNode', {
    backendNodeId: link.backendDOMNodeId,
  });
  assert.match(resolved.object.objectId, /^mogbot-fallback:\d+$/);
  const r = await cdp.send('ana', tab, 'Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: SCROLL_WITHIN_FN,
    arguments: [{ value: 0 }, { value: 360 }],
  });
  assert.equal(r.result.value, 'moved');
  assert.equal(pane.scrollTop, 360);
  // Its box, to click it, is the debugger's: refused as gone, so the agent
  // reads again. Even once the debugger gets in, a negative id never goes to Chrome.
  chrome.debugger.attachError = null;
  await assert.rejects(
    cdp.send('ana', tab, 'DOM.getBoxModel', { backendNodeId: link.backendDOMNodeId }),
    (e) => e.code === CODES.cdp && /No node/.test(e.message)
  );
  assert.equal(sent.length, 0);
  // A node that left the page is gone.
  pane.remove();
  await assert.rejects(
    cdp.send('ana', tab, 'DOM.resolveNode', { backendNodeId: link.backendDOMNodeId }),
    (e) => e.code === CODES.cdp
  );
});

test('going to an address works without the debugger; the user’s Cancel still stops it all', async () => {
  page('<p>x</p>');
  const { cdp, tab, chrome } = await blocked();
  await cdp.send('ana', tab, 'Page.navigate', { url: 'https://www.linkedin.com/in/someone/' });
  assert.equal((await chrome.tabs.get(tab)).url, 'https://www.linkedin.com/in/someone/');
  chrome.debugger.onDetach.fire({ tabId: tab }, 'canceled_by_user');
  await assert.rejects(
    cdp.send('ana', tab, 'Runtime.evaluate', { expression: TEXT_JS }),
    (e) => e.code === CODES.attachFailed
  );
  await assert.rejects(
    cdp.send('ana', tab, 'DOM.resolveNode', { backendNodeId: -1 }),
    (e) => e.code === CODES.attachFailed
  );
});

test('the line names one or several extensions, or says Chrome didn’t say', () => {
  assert.match(inTheWayMessage([]), /Chrome didn’t say which/);
  assert.match(
    inTheWayMessage([{ label: '“A” (x)' }, { label: '“B” (y)' }]),
    /^“A” \(x\), “B” \(y\) put their own frames/
  );
  assert.equal(typeof PAGE.pageTree, 'function');
});
