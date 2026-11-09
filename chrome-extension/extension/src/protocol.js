// The messages between this extension and the app, as the app's
// `src-tauri/src/user_chrome/protocol.rs` defines them. Rust tests read this
// file and fail when the two drift (the version, every op, every code).

/** The protocol this extension speaks. */
export const PROTOCOL = 1;

/**
 * The native host Chrome starts for this extension: the app's own binary.
 * Must match `install::host_name()` (checked by `pnpm check:brand`).
 */
export const HOST_NAME = 'io.native.dashbot.chrome_link';

/** Every op the app may ask for. */
export const OPS = [
  'ping',
  'tabs_list',
  'tabs_open',
  'tab_get',
  'tab_close',
  'tab_focus',
  'release',
  'cdp',
];

/** Every error code this extension answers with. */
export const CODES = {
  badRequest: 'bad_request',
  notOwned: 'not_owned',
  noTab: 'no_tab',
  notAllowed: 'not_allowed',
  attachFailed: 'attach_failed',
  cdp: 'cdp',
  protected: 'protected',
  busy: 'busy',
  internal: 'internal',
};

/** An error the app is told about, with a code it acts on. */
export class ExtError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message a line a person can read
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The first message on a link. */
export function hello({ version, profileId, profileLabel, userAgent }) {
  return {
    t: 'hello',
    v: PROTOCOL,
    extension_version: version,
    profile_id: profileId,
    profile_label: profileLabel || '',
    user_agent: userAgent || '',
  };
}

/** The answer to request `id`. */
export function ok(id, result) {
  return { t: 'res', id, ok: true, result: result === undefined ? null : result };
}

/** A refusal of request `id`. */
export function fail(id, error) {
  const code = error instanceof ExtError ? error.code : CODES.internal;
  const message = String((error && error.message) || error || 'no reason given').slice(0, 500);
  return { t: 'res', id, ok: false, error: { code, message } };
}

/** Something happened to one of the agents' tabs. */
export function event(kind, fields) {
  return { t: 'event', event: { kind, ...fields } };
}

/**
 * Check a request from the app is one this extension understands.
 * @returns {{id: number, op: object}}
 */
export function parseRequest(msg) {
  if (
    !msg ||
    msg.t !== 'req' ||
    !Number.isInteger(msg.id) ||
    !msg.op ||
    typeof msg.op !== 'object'
  ) {
    throw new ExtError(CODES.badRequest, 'not a request');
  }
  if (!OPS.includes(msg.op.kind)) {
    throw new ExtError(CODES.badRequest, `unknown op: ${String(msg.op.kind).slice(0, 40)}`);
  }
  return { id: msg.id, op: msg.op };
}

/** Only web pages: http and https. */
export function isWebUrl(u) {
  try {
    const p = new URL(String(u));
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}
