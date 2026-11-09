/**
 * Where a portalled menu fits in the window (primitives/Dropdown.tsx): which
 * side of its trigger it opens on, and how tall it may be.
 *
 * @module lib/menuFit
 */

/** Between the trigger and the menu, and kept clear at the window's edge. */
export const MENU_GAP = 6;
const MENU_EDGE = 8;
/** Below this a menu is a pointless scroll box: it flips instead, if it can. */
const MENU_MIN_HEIGHT = 120;

/**
 * Which side a portalled menu opens on and how tall it may be. The side asked
 * for wins while the menu fits there (or nothing would fit better); else the
 * side with more room. The height is capped at that side's room, so a long
 * menu scrolls inside the window instead of running off it.
 */
export function fitMenu(
  trigger: { top: number; bottom: number },
  viewportHeight: number,
  menuHeight: number,
  preferred: 'top' | 'bottom'
): { side: 'top' | 'bottom'; maxHeight: number } {
  const room = {
    bottom: viewportHeight - trigger.bottom - MENU_GAP - MENU_EDGE,
    top: trigger.top - MENU_GAP - MENU_EDGE,
  };
  const other = preferred === 'top' ? 'bottom' : 'top';
  const fits = menuHeight <= room[preferred];
  // A short room is still fine while the menu fits in it; a menu that
  // doesn't fit goes where there's more room, unless that's barely more.
  const side =
    fits || room[preferred] >= Math.min(room[other], Math.max(menuHeight, MENU_MIN_HEIGHT))
      ? preferred
      : other;
  return { side, maxHeight: Math.max(0, Math.floor(room[side])) };
}
