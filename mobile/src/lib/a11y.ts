/**
 * Spoken announcements for VoiceOver and TalkBack. `accessibilityLiveRegion`
 * is Android-only, so on iOS a reply, an approval or a failure would
 * otherwise arrive in silence.
 */

import { AccessibilityInfo } from 'react-native';

let screenReader = false;
void AccessibilityInfo.isScreenReaderEnabled().then(
  (on) => (screenReader = on),
  () => {}
);
AccessibilityInfo.addEventListener('screenReaderChanged', (on) => (screenReader = on));

/**
 * Say `text` if a screen reader is on. `queue`: wait for what's being read
 * to finish instead of cutting it off (iOS; Android always queues).
 */
export function announce(text: string, queue = false) {
  if (!screenReader || !text) return;
  // react-native-web (the QA build) has only the plain call.
  if (typeof AccessibilityInfo.announceForAccessibilityWithOptions === 'function') {
    AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue });
  } else AccessibilityInfo.announceForAccessibility(text);
}

/** How much of a reply is read out on its own: past it, the rest is in the chat. */
export const SAY_REPLY_MAX = 280;

/**
 * What VoiceOver says when a reply lands. In the chat it came to, the reply
 * itself (`words`, already as said: `speakable`), cut at a sentence near
 * `SAY_REPLY_MAX`, so a streamed answer isn't only "replied" with the words
 * still to find; anywhere else, who replied.
 */
export function replyAnnouncement(name: string, words: string, here: boolean): string {
  if (!here || !words) return `${name} replied`;
  if (words.length <= SAY_REPLY_MAX) return `${name}: ${words}`;
  const head = words.slice(0, SAY_REPLY_MAX);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  const cut =
    end > SAY_REPLY_MAX / 2 ? head.slice(0, end + 1) : `${head.slice(0, head.lastIndexOf(' '))}…`;
  return `${name}: ${cut} More in the chat.`;
}
