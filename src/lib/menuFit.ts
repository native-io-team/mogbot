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

/**
 * Where a portalled menu sits across the window: against the trigger's edge
 * asked for while the menu fits there, else against its other edge (a menu
 * from a trigger near the right edge lines up with the trigger's right), and
 * held `MENU_EDGE` inside the window when neither fits. Answers the one
 * inline edge to set, so a menu whose width changes stays put on that edge.
 *
 * `area` narrows "the window" to part of it (the chat beside the sidebar,
 * say): the menu is held inside that, in window coordinates, as well.
 */
export function fitMenuX(
  trigger: { left: number; right: number },
  viewportWidth: number,
  menuWidth: number,
  preferred: 'left' | 'right',
  area?: { left: number; right: number }
): { left: number } | { right: number } {
  const lo = Math.max(MENU_EDGE, (area?.left ?? 0) + MENU_EDGE);
  const hi = Math.min(viewportWidth, area?.right ?? viewportWidth) - MENU_EDGE;
  const fitsFromLeft = Math.max(lo, trigger.left) + menuWidth <= hi;
  const fitsFromRight = Math.min(hi, trigger.right) - menuWidth >= lo;
  const fromLeft = { left: Math.max(lo, trigger.left) };
  const fromRight = { right: viewportWidth - Math.min(hi, trigger.right) };
  if (preferred === 'left' ? fitsFromLeft : !fitsFromRight && fitsFromLeft) return fromLeft;
  if (fitsFromRight) return fromRight;
  // Wider than either side allows: as far left as keeps its right edge in.
  return { left: Math.max(lo, hi - menuWidth) };
}
