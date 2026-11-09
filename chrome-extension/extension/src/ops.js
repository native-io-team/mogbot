// What each op from the app does.

import { CODES, ExtError } from './protocol.js';

function tabId(op) {
  if (!Number.isInteger(op.tab_id)) throw new ExtError(CODES.badRequest, 'no tab');
  return op.tab_id;
}

/**
 * @param {object} op one of protocol.OPS, already checked by parseRequest
 * @param {{tabs: import('./tabs.js').Tabs, cdp: import('./cdp.js').Cdp}} parts
 */
export async function handle(op, { tabs, cdp }) {
  switch (op.kind) {
    case 'ping':
      return {};
    case 'tabs_list':
      return tabs.list();
    case 'tabs_open':
      return tabs.open(op.agent, op.label, op.url, op.color);
    case 'tab_get':
      return tabs.get(op.agent, tabId(op));
    case 'tab_close':
      return tabs.close(op.agent, tabId(op));
    case 'tab_focus':
      return tabs.focus(op.agent, tabId(op));
    case 'release':
      await cdp.release(op.agent);
      return tabs.release(op.agent);
    case 'cdp':
      if (typeof op.method !== 'string') throw new ExtError(CODES.badRequest, 'no method');
      return cdp.send(op.agent, tabId(op), op.method, op.params);
    default:
      throw new ExtError(CODES.badRequest, 'unknown op');
  }
}
