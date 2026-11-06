/**
 * The phone signing in to a site in this Mac's Chrome
 * (`src-tauri/src/agents/phone_signin.rs`): the bar's state and its Stop.
 * The phone drives one tab the app opened; the desk only says so.
 *
 * @module lib/phoneSignin
 */

import { invoke } from '@tauri-apps/api/core';

/** What the bar shows while a phone is signing in. */
export interface PhoneSignin {
  /** "figma.com". */
  domain: string;
  deviceName: string;
  startedAt: number;
}

/** Fired with the new state (or null) whenever one starts or ends. */
export const PHONE_SIGNIN_EVENT = 'agents://phone-signin';

export const getPhoneSignin = () => invoke<PhoneSignin | null>('agents_phone_signin_status');
/** Ends it: the tab closes and the phone is told. */
export const stopPhoneSignin = () => invoke<void>('agents_phone_signin_stop');

export function phoneSigninTitle(s: PhoneSignin): string {
  return `Your phone is signing in to ${s.domain}`;
}

export const PHONE_SIGNIN_DETAIL =
  'It’s using a tab of its own in Chrome on this Mac. What’s typed there isn’t kept, and agents stay out of Chrome until it’s done.';
