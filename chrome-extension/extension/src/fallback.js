// Reading an agent's tab when Chrome won't let the debugger in.
//
// Chrome refuses `chrome.debugger.attach` on any tab that holds another
// extension's frame ("Cannot access a chrome-extension:// URL of different
// extension"), and some extensions put one in every page they see, which
// closed every tab to agents at once. When that happens this file names the
// extension in the way (`inTheWay`), and answers what reading needs without
// the debugger, through `chrome.scripting`: the page's text, its load state
// and visibility, a tree shaped like Chrome's accessibility tree, scrolling
// (the page, or the box around a control) and going to an address. Clicking,
// typing, keys, screenshots and attaching a picture still need the debugger,
// and are refused with the name of the extension in the way.
//
// Every function run in a page is one of this file's own (`PAGE`), in the
// extension's isolated world, where the page's scripts can't see or change
// it, and gets only numbers. Nodes it names carry negative ids, which Chrome
// never gives, so a ref read this way can never land on a node the debugger
// knows by the same number.

import { CODES, ExtError } from './protocol.js';

/** What Chrome says when another extension's frame is in the tab. */
const FOREIGN_FRAME = /chrome-extension:\/\/ URL of different extension/i;

/** An extension's id, in a `chrome-extension://` address. */
const EXTENSION_URL = /^chrome-extension:\/\/([a-p]{32})\//;

/** An object id this file hands out for a node it read. */
const OBJECT_ID = /^mogbot-fallback:(\d{1,9})$/;

/** The most nodes one tree read returns: the app shows 14,000 characters. */
export const MAX_NODES = 20000;

/** Whether an attach failed because another extension's frame is in the tab. */
export function foreignFrame(error) {
  return FOREIGN_FRAME.test(String((error && error.message) || error || ''));
}

/* ------------------------------------------------------ in the page */
// Each runs in the page through `chrome.scripting.executeScript`, so each
// stands alone: nothing from this module's scope reaches it.

/** The page's visible text (`TEXT_JS`). */
function pageText() {
  return document.body ? document.body.innerText : '';
}

/** `READY_JS`. */
function pageReady() {
  return document.readyState;
}

/** `VISIBILITY_JS`. */
function pageVisibility() {
  return document.visibilityState;
}

/** One scroll step of the page itself (`SCROLL_*_JS`). */
function pageScrollBy(dx, dy) {
  window.scrollBy(dx, dy);
}

/** The ids of the extensions whose frames this page shows (open shadow roots too). */
function pageExtensionFrames() {
  const ids = new Set();
  const walk = (root) => {
    for (const e of root.querySelectorAll('iframe, frame, embed, object')) {
      const src = e.getAttribute('src') || e.getAttribute('data') || '';
      const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(src);
      if (m) ids.add(m[1]);
    }
    for (const h of root.querySelectorAll('*')) if (h.shadowRoot) walk(h.shadowRoot);
  };
  walk(document);
  return [...ids];
}

/**
 * The page as nodes shaped like `Accessibility.getFullAXTree`'s: a role, a
 * name worked out the way Chrome does for the common cases, a value, the
 * disabled, checked and protected properties, and children. Hidden things
 * are left out; elements with no role and no name fold into their parent.
 * Each element gets a number kept for the document's life, given back
 * negated as its `backendDOMNodeId`.
 */
function pageTree(maxNodes) {
  const S =
    globalThis.__mogbotFallback ||
    (globalThis.__mogbotFallback = { next: 1, ids: new WeakMap(), els: new Map() });
  S.els = new Map();
  const clip = (s, n) => {
    const t = String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > n ? t.slice(0, n) : t;
  };
  const idOf = (el) => {
    let id = S.ids.get(el);
    if (!id) {
      id = S.next++;
      S.ids.set(el, id);
    }
    S.els.set(id, new WeakRef(el));
    return -id;
  };
  const shown = (el) => (el.checkVisibility ? el.checkVisibility() : true);
  const insideSection = (el) =>
    !!(el.parentElement && el.parentElement.closest('article, aside, main, nav, section'));
  const ROLES = {
    BUTTON: 'button',
    TEXTAREA: 'textbox',
    OPTION: 'option',
    NAV: 'navigation',
    MAIN: 'main',
    ASIDE: 'complementary',
    FORM: 'form',
    DIALOG: 'dialog',
    UL: 'list',
    OL: 'list',
    MENU: 'list',
    LI: 'listitem',
    TABLE: 'table',
    TR: 'row',
    TD: 'cell',
    TH: 'columnheader',
    ARTICLE: 'article',
    SUMMARY: 'button',
    H1: 'heading',
    H2: 'heading',
    H3: 'heading',
    H4: 'heading',
    H5: 'heading',
    H6: 'heading',
  };
  const INPUTS = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    file: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    number: 'spinbutton',
    search: 'searchbox',
  };
  const FROM_CONTENT = new Set([
    'button',
    'link',
    'heading',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'checkbox',
    'radio',
    'switch',
    'treeitem',
    'cell',
    'columnheader',
    'rowheader',
    'tooltip',
  ]);
  const roleOf = (el) => {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (explicit === 'none' || explicit === 'presentation') return '';
    if (explicit) return explicit;
    const tag = el.tagName.toUpperCase();
    if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (INPUTS[t]) return INPUTS[t];
      return el.hasAttribute('list') ? 'combobox' : 'textbox';
    }
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'IMG') return el.getAttribute('alt') === '' ? '' : 'image';
    if (tag === 'HEADER') return insideSection(el) ? '' : 'banner';
    if (tag === 'FOOTER') return insideSection(el) ? '' : 'contentinfo';
    if (tag === 'SECTION')
      return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
    if (ROLES[tag]) return ROLES[tag];
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable))
      return 'textbox';
    return '';
  };
  const labelledBy = (el) => {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return ids
      .map((i) => {
        const t = el.ownerDocument.getElementById(i);
        return t ? t.textContent : '';
      })
      .join(' ');
  };
  const nameOf = (el, role) => {
    const by = clip(labelledBy(el), 400);
    if (by) return by;
    const aria = clip(el.getAttribute('aria-label'), 400);
    if (aria) return aria;
    const tag = el.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const t = (el.type || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(t))
        return clip(el.value || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : ''), 400);
      if (t === 'image') return clip(el.getAttribute('alt') || el.value, 400);
      const labels = el.labels ? [...el.labels].map((l) => l.textContent).join(' ') : '';
      return clip(labels || el.getAttribute('placeholder') || el.getAttribute('title'), 400);
    }
    if (tag === 'IMG') return clip(el.getAttribute('alt') || el.getAttribute('title'), 400);
    if (FROM_CONTENT.has(role)) {
      const t = clip(el.textContent, 400);
      if (t) return t;
    }
    return clip(el.getAttribute('title'), 400);
  };
  const secret = (el) => {
    const t = (el.type || '').toLowerCase();
    const a = (el.getAttribute('autocomplete') || '').toLowerCase();
    return (
      t === 'password' ||
      a.includes('one-time-code') ||
      a.includes('current-password') ||
      a.includes('new-password')
    );
  };
  const valueOf = (el, role) => {
    const tag = el.tagName.toUpperCase();
    if (tag === 'SELECT') {
      const o = el.selectedOptions && el.selectedOptions[0];
      return o ? clip(o.textContent, 200) : '';
    }
    if (!['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'].includes(role)) return '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return clip(el.value, 200);
    if (el.isContentEditable) return clip(el.textContent, 200);
    return '';
  };
  const propsOf = (el, role) => {
    const props = [];
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true')
      props.push({ name: 'disabled', value: { type: 'boolean', value: true } });
    let checked = el.getAttribute('aria-checked');
    if (el.tagName.toUpperCase() === 'INPUT' && (role === 'checkbox' || role === 'radio'))
      checked = el.checked ? 'true' : 'false';
    if (checked) props.push({ name: 'checked', value: { type: 'tristate', value: checked } });
    if (secret(el)) props.push({ name: 'protected', value: { type: 'boolean', value: true } });
    return props;
  };
  const kidsOf = (n) => {
    if (n.nodeType !== 1) return n.childNodes ? [...n.childNodes] : [];
    const tag = n.tagName.toUpperCase();
    if (tag === 'IFRAME' || tag === 'FRAME') {
      let d = null;
      try {
        d = n.contentDocument;
      } catch {
        d = null;
      }
      return d && d.body ? [d.body] : [];
    }
    if (tag === 'SLOT') {
      const a = n.assignedNodes ? n.assignedNodes({ flatten: true }) : [];
      return a.length ? a : [...n.childNodes];
    }
    if (n.shadowRoot) return [...n.shadowRoot.childNodes];
    return [...n.childNodes];
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);

  const root = {
    nodeId: 'r',
    ignored: false,
    role: { type: 'role', value: 'RootWebArea' },
    name: { type: 'computedString', value: clip(document.title, 400) },
    childIds: [],
  };
  const nodes = [root];
  let next = 0;
  let truncated = false;
  // Depth-first in document order: children pushed reversed.
  const stack = document.body ? [{ n: document.body, parent: root }] : [];
  while (stack.length) {
    if (nodes.length >= maxNodes) {
      truncated = true;
      break;
    }
    const { n, parent } = stack.pop();
    if (n.nodeType === 3) {
      const t = clip(n.nodeValue, 500);
      if (!t) continue;
      const node = {
        nodeId: 'n' + next++,
        parentId: parent.nodeId,
        ignored: false,
        role: { type: 'role', value: 'StaticText' },
        name: { type: 'computedString', value: t },
        childIds: [],
      };
      parent.childIds.push(node.nodeId);
      nodes.push(node);
      continue;
    }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName.toUpperCase();
    if (SKIP.has(tag) || n.getAttribute('aria-hidden') === 'true' || !shown(n)) continue;
    if (tag === 'INPUT' && (n.type || '').toLowerCase() === 'hidden') continue;
    const role = roleOf(n);
    const name = role ? nameOf(n, role) : '';
    let into = parent;
    if (role) {
      const node = {
        nodeId: 'n' + next++,
        parentId: parent.nodeId,
        ignored: false,
        role: { type: 'role', value: role },
        name: { type: 'computedString', value: name },
        properties: propsOf(n, role),
        childIds: [],
        backendDOMNodeId: idOf(n),
      };
      const value = secret(n) ? '' : valueOf(n, role);
      if (value) node.value = { type: 'string', value };
      parent.childIds.push(node.nodeId);
      nodes.push(node);
      into = node;
    }
    // An svg's insides, and a field's, are never read out.
    if (tag === 'SVG' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') continue;
    const kids = kidsOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ n: kids[i], parent: into });
  }
  return { nodes, truncated };
}

/** Whether node `id` (from `pageTree`) is still in the page. */
function pageHasNode(id) {
  const S = globalThis.__mogbotFallback;
  const ref = S && S.els.get(id);
  const el = ref && ref.deref();
  return !!(el && el.isConnected);
}

/**
 * `SCROLL_WITHIN_FN` on node `id` (from `pageTree`): the node or its nearest
 * ancestor that scrolls that way, through shadow roots. `gone` when the node
 * left the page.
 */
function pageScrollWithin(id, dx, dy) {
  const S = globalThis.__mogbotFallback;
  const ref = S && S.els.get(id);
  const node = ref && ref.deref();
  if (!node || !node.isConnected) return 'gone';
  let e = node.nodeType === 1 ? node : node.parentElement;
  for (let i = 0; e && i < 64; i++) {
    if (e.nodeType === 1 && e !== document.body && e !== document.documentElement) {
      const s = getComputedStyle(e);
      const y =
        dy !== 0 && /(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight;
      const x =
        dx !== 0 && /(auto|scroll|overlay)/.test(s.overflowX) && e.scrollWidth > e.clientWidth;
      if (x || y) {
        const t = e.scrollTop,
          l = e.scrollLeft;
        e.scrollBy({ left: dx, top: dy, behavior: 'instant' });
        return e.scrollTop !== t || e.scrollLeft !== l ? 'moved' : 'end';
      }
    }
    const r = e.getRootNode && e.getRootNode();
    e = e.parentElement || (r && r.host) || null;
  }
  return 'none';
}

/** The page functions, for tests. */
export const PAGE = {
  pageText,
  pageReady,
  pageVisibility,
  pageScrollBy,
  pageExtensionFrames,
  pageTree,
  pageHasNode,
  pageScrollWithin,
};

/**
 * The app's expressions this file answers (a copy of the strings in
 * `cdp.js`'s `EXPRESSIONS`; a test holds them equal). Not the focused-field
 * check: it is asked only before typing, which needs the debugger.
 */
export const EXPRESSIONS = new Map([
  ["document.body ? document.body.innerText : ''", { func: pageText, args: [] }],
  ['document.readyState', { func: pageReady, args: [] }],
  ['document.visibilityState', { func: pageVisibility, args: [] }],
  ['window.scrollBy(0, -120)', { func: pageScrollBy, args: [0, -120] }],
  ['window.scrollBy(0, 120)', { func: pageScrollBy, args: [0, 120] }],
  ['window.scrollBy(-120, 0)', { func: pageScrollBy, args: [-120, 0] }],
  ['window.scrollBy(120, 0)', { func: pageScrollBy, args: [120, 0] }],
]);

/** A node this file named: its number, from a negative backend id. */
function fallbackNode(params) {
  const id = params && params.backendNodeId;
  return Number.isInteger(id) && id < 0 ? -id : null;
}

/** A node this file resolved: its number, from the object id it gave. */
function fallbackObject(params) {
  const m = OBJECT_ID.exec(String((params && params.objectId) || ''));
  return m ? Number(m[1]) : null;
}

/** What the CDP answer for a value looks like. */
function remote(value) {
  return value === undefined
    ? { result: { type: 'undefined' } }
    : { result: { type: typeof value, value } };
}

const GONE = 'No node with given id found';

export class Fallback {
  /**
   * @param {typeof chrome} chrome
   * @param {string} scrollWithinFn the app's `SCROLL_WITHIN_FN`, answered
   *   here on nodes this file named
   */
  constructor(chrome, scrollWithinFn) {
    this.chrome = chrome;
    this.scrollWithinFn = scrollWithinFn;
  }

  /**
   * The command names a node only this file knows (a ref read without the
   * debugger), so it is answered here or refused, never sent to Chrome.
   */
  ownsNode(params) {
    return fallbackNode(params) !== null || fallbackObject(params) !== null;
  }

  /** This file can answer the (already vetted) command without the debugger. */
  can(method, params) {
    switch (method) {
      case 'Runtime.evaluate':
        return EXPRESSIONS.has(params.expression);
      case 'Accessibility.getFullAXTree':
      case 'Page.navigate':
        return true;
      case 'DOM.resolveNode':
        return fallbackNode(params) !== null;
      case 'Runtime.callFunctionOn':
        return (
          params.functionDeclaration === this.scrollWithinFn && fallbackObject(params) !== null
        );
      default:
        return false;
    }
  }

  async inPage(tabId, func, args) {
    let got;
    try {
      got = await this.chrome.scripting.executeScript({
        target: { tabId },
        func,
        args,
        injectImmediately: true,
      });
    } catch (e) {
      throw new ExtError(CODES.cdp, String((e && e.message) || e));
    }
    const first = Array.isArray(got) ? got[0] : null;
    if (!first) throw new ExtError(CODES.cdp, 'the page didn’t answer');
    if (first.error) throw new ExtError(CODES.cdp, String(first.error.message || first.error));
    return first.result;
  }

  /**
   * Answer one command without the debugger, in the shape Chrome's answer
   * has. `inTheWay` names what kept the debugger out, for tree reads.
   */
  async run(tabId, method, params, inTheWay = []) {
    if (!this.can(method, params)) {
      // A node from a read made without the debugger, asked about in a way
      // only the debugger answers (its box, to click it): read again.
      throw new ExtError(CODES.cdp, GONE);
    }
    switch (method) {
      case 'Runtime.evaluate': {
        const { func, args } = EXPRESSIONS.get(params.expression);
        return remote(await this.inPage(tabId, func, args));
      }
      case 'Accessibility.getFullAXTree': {
        const t = await this.inPage(tabId, pageTree, [MAX_NODES]);
        return {
          nodes: (t && t.nodes) || [],
          withoutDebugger: { inTheWay: inTheWay.map((x) => x.label) },
        };
      }
      case 'Page.navigate':
        try {
          await this.chrome.tabs.update(tabId, { url: params.url });
        } catch (e) {
          throw new ExtError(CODES.cdp, String((e && e.message) || e));
        }
        return {};
      case 'DOM.resolveNode': {
        const id = fallbackNode(params);
        if (!(await this.inPage(tabId, pageHasNode, [id]))) throw new ExtError(CODES.cdp, GONE);
        return { object: { type: 'object', subtype: 'node', objectId: `mogbot-fallback:${id}` } };
      }
      case 'Runtime.callFunctionOn': {
        const id = fallbackObject(params);
        const [dx, dy] = params.arguments.map((a) => a.value);
        const r = await this.inPage(tabId, pageScrollWithin, [id, dx, dy]);
        if (r === 'gone') throw new ExtError(CODES.cdp, GONE);
        return remote(r);
      }
      default:
        throw new ExtError(CODES.cdp, GONE);
    }
  }

  /**
   * The extensions whose frames are in the tab, each `{id, label}`: from the
   * debugger's targets (frames Chrome runs apart, with their tab) and the
   * page's own frames, named by `chrome.management` where it can.
   */
  async inTheWay(tabId) {
    const ids = new Set();
    try {
      for (const t of await this.chrome.debugger.getTargets()) {
        const m = EXTENSION_URL.exec(String(t.url || ''));
        if (m && t.tabId === tabId) ids.add(m[1]);
      }
    } catch {
      // The page's own frames may still say.
    }
    try {
      const found = await this.inPage(tabId, pageExtensionFrames, []);
      if (Array.isArray(found)) for (const id of found) ids.add(String(id));
    } catch {
      // Then the targets are all there is.
    }
    ids.delete(this.chrome.runtime.id);
    const out = [];
    for (const id of [...ids].sort()) {
      let name = '';
      try {
        const info = await this.chrome.management.get(id);
        name = String((info && info.name) || '').slice(0, 60);
      } catch {
        // Not installed in this profile, or no way to ask: the id says enough.
      }
      out.push({ id, name, label: name ? `“${name}” (${id})` : `an extension with id ${id}` });
    }
    return out;
  }
}

/** The line the app is told when the debugger can't get in. */
export function inTheWayMessage(found) {
  if (!found.length) {
    return 'Another extension puts its own frame in this page (Chrome didn’t say which), and Chrome won’t let an extension drive a tab that holds another extension’s frame.';
  }
  const who = found.map((x) => x.label).join(', ');
  const verb = found.length === 1 ? 'puts its own frame' : 'put their own frames';
  return `${who} ${verb} in this page, and Chrome won’t let an extension drive a tab that holds another extension’s frame.`;
}
