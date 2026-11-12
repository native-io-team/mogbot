/**
 * The phone signing in to a site on this Mac
 * (`src-tauri/src/agents/phone_signin.rs`): the bar's state and its Stop.
 * The phone drives one window of the agents' own Chrome (or, for an older
 * card, one tab of the user's Chrome); the desk only says so.
 *
 * @module lib/phoneSignin
 */

import { invoke } from '@tauri-apps/api/core';
import { THIS_COMPUTER } from './computer';

/** What the bar shows while a phone is signing in. */
export interface PhoneSignin {
  /** "figma.com". */
  domain: string;
  deviceName: string;
  startedAt: number;
  /** How the phone sees it: the agents' browser, the user's Chrome, or a plain window. */
  via?: 'agents_browser' | 'chrome' | 'mac_window';
}

/** Fired with the new state (or null) whenever one starts or ends. */
export const PHONE_SIGNIN_EVENT = 'agents://phone-signin';

export const getPhoneSignin = () => invoke<PhoneSignin | null>('agents_phone_signin_status');
/** Ends it: the tab closes and the phone is told. */
export const stopPhoneSignin = () => invoke<void>('agents_phone_signin_stop');

export function phoneSigninTitle(s: PhoneSignin): string {
  return `Your phone is signing in to ${s.domain}`;
}

/** The bar's second line: where it is, and what that means for agents. */
export function phoneSigninDetail(s: PhoneSignin): string {
  switch (s.via) {
    case 'agents_browser':
      return `It’s using a window of the agents’ own browser on ${THIS_COMPUTER}. What’s typed there isn’t kept, and the agent it’s for waits until it’s done.`;
    case 'mac_window':
      return `It’s using a plain Chrome window on ${THIS_COMPUTER}, shown on the phone. What’s typed there isn’t kept; the agents’ browser is closed until it’s done.`;
    default:
      return `It’s using a tab of its own in Chrome on ${THIS_COMPUTER}. What’s typed there isn’t kept, and agents stay out of Chrome until it’s done.`;
  }
}
