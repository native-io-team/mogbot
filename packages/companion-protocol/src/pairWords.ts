import { APP_NAME } from './brand.gen';

/**
 * The words pairing is said in, on both sides. The phone tells someone what
 * to click on the Mac, and the Mac tells them what to tap on the phone, so
 * each label is one string both read: a rename on one side can't leave the
 * other pointing at a button that no longer exists.
 */

/** The desk's sidebar row with no phone paired, its ⌘K command and its Settings button. */
export const PAIR_YOUR_PHONE = 'Pair your phone';

/** Where that row is on the desk. */
export const PAIR_WHERE = 'at the bottom of the sidebar';

/** The phone's big button that opens the camera (the step that sends the person to the desk). */
export const SCAN_THE_CODE = 'Scan the code';

/** The phone's button on its confirm screen. */
export const PAIR_BUTTON = 'Pair';

/** The desk's answer on the request card. */
export const ALLOW_BUTTON = 'Allow';

/*
 * The steps, one screen each, said the same on both sides. The desk walks
 * them in onboarding and the Phone panel; the phone walks its half in
 * `mobile/src/app/pair.tsx`. Where one side names the other's button, it
 * reads the constant above, never its own copy.
 */

/**
 * The phone's first screen. Nothing on the phone works until the Mac is set
 * up (a tester opened the phone first and was lost at Tailscale), so it says
 * that before anything else.
 */
export const HAVE_MAC_TITLE = 'Start at your computer';
export const HAVE_MAC_LINE = `Your agents run on your Mac, so set ${APP_NAME} up there first. Its last step tells you when to pick up this phone. Until then, nothing here can work.`;
/** Its answers. */
export const MAC_READY = 'My Mac is set up';
export const MAC_NOT_YET = 'I don’t have it on my Mac yet';

/** Its answer when not: the Mac comes first, because the agents run there. */
export const GET_MAC_TITLE = `Get ${APP_NAME} on your Mac first`;
export const GET_MAC_LINE =
  'Download it on your Mac, open it and follow its steps, at your desk. When it’s ready it asks you to pick up this phone and comes back here.';

/** The phone app, from the desk. */
export const GET_PHONE_APP_TITLE = `Get ${APP_NAME} on your phone`;

/** Tailscale: the private link between the two, on each side. */
export const TAILSCALE_MAC_TITLE = 'Turn on Tailscale on this Mac';
export const TAILSCALE_PHONE_TITLE = 'Turn on Tailscale on this phone';
/** The same step, said from the desk about the phone. */
export const TAILSCALE_YOUR_PHONE_TITLE = 'Turn on Tailscale on your phone';
export const TAILSCALE_LINE =
  'Tailscale is a free app that links your phone to your Mac privately, wherever you are.';
/** On the Mac, where the account is made: the phone uses the same one later. */
export const TAILSCALE_ACCOUNT_LINE =
  'You make one free account here (Google, Apple or Microsoft sign-in works) and use the same one on your phone.';
/** Said wherever the phone's Tailscale is asked for: the one way pairing fails silently. */
export const SAME_ACCOUNT_LINE = 'Sign in with the same account you used on your Mac.';

/** The desk's switch that lets a phone reach it. */
export const PHONE_ACCESS_TITLE = 'Turn on phone access';

/** The phone's step that sends the person to the desk; its button is SCAN_THE_CODE. */
export const CLICK_PAIR_TITLE = `On your Mac, click “${PAIR_YOUR_PHONE}” ${PAIR_WHERE}`;

/** The one line beside the desk's QR. */
export const SCAN_LINE = `On your phone, open ${APP_NAME} and tap ${SCAN_THE_CODE}`;

/** The phone, waiting for the desk. */
export const CLICK_ALLOW_TITLE = `Click ${ALLOW_BUTTON} on your Mac`;

/** The end, on both. */
export const PAIRED_TITLE = 'Paired';

/** An optional step's way past, on both. */
export const SKIP_FOR_NOW = 'Skip for now';

/** "I did that" where only the person can know (the phone's own Tailscale, the app on it). */
export const I_DID_IT = 'I did it';
