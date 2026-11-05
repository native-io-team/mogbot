/**
 * Protocol version negotiation.
 *
 * One integer, bumped only for a breaking change (a field removed or retyped,
 * a method's meaning changed). Adding an optional field, a method or an event
 * is not breaking: both sides ignore what they don't know, and the phone
 * learns which methods the Mac has from `welcome.methods`.
 *
 * The Mac keeps answering the previous version for at least one release after
 * a bump, so an app that hasn't taken its OTA update yet keeps working.
 */

/**
 * 2: the Mac proves who it is first (`challenge` → `identity`, before
 * `hello`), and pairing signs the hosts. Nothing has shipped on 1, so the Mac
 * no longer answers it: an app on 1 is told to update, and an app on 2 that
 * reaches a Mac on 1 says to update the Mac.
 */
export const PROTOCOL_VERSION = 2;
export const MIN_PROTOCOL_VERSION = 2;

export interface ProtocolRange {
  min: number;
  max: number;
}

export const SUPPORTED: ProtocolRange = { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION };

export type Negotiation =
  | { ok: true; version: number }
  /** Which side has to update, named so the message can say which. */
  | { ok: false; update: 'app' | 'mac' };

/** The highest version both speak; otherwise which side is behind. */
export function negotiate(phone: ProtocolRange, mac: ProtocolRange): Negotiation {
  if (phone.max < mac.min) return { ok: false, update: 'app' };
  if (mac.max < phone.min) return { ok: false, update: 'mac' };
  return { ok: true, version: Math.min(phone.max, mac.max) };
}
