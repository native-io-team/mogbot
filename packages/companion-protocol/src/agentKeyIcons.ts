/**
 * The legends printed on agent keys: the one registry of their drawings, so
 * a designer's final set replaces this file and nothing else
 * (docs/internal/agent-keys.md, "Icons"). Which icons exist, and their names,
 * are in `agent-keys.json` (the Mac reads it too); a test holds the two to
 * the same ids.
 *
 * These are placeholders that follow the rules the final set will: keyboard
 * legends, not app icons. A 24-unit grid, one uniform stroke, no fills,
 * square caps and miter joins, only horizontal, vertical and 45-degree lines
 * plus plain circles. Symbols over pictures. Each is drawn by both clients
 * from the same data: `paths` as SVG path data (M, H, V, L, Z only) and
 * `circles` as `[cx, cy, r]`.
 */

export interface KeyIconDrawing {
  paths: string[];
  circles?: [number, number, number][];
}

/** The grid every legend is drawn on. */
export const KEY_ICON_GRID = 24;

export const KEY_ICON_DRAWINGS: Record<string, KeyIconDrawing> = {
  // Two squares, one turned: an eight-point star. The Chief's.
  star: { paths: ['M6 6H18V18H6Z', 'M12 3L21 12L12 21L3 12Z'] },
  // A down-arrow into a tray.
  inbox: { paths: ['M12 3V11M8 7L12 11L16 7', 'M3 13V21H21V13H16L14 15H10L8 13Z'] },
  code: { paths: ['M9 6L3 12L9 18M15 6L21 12L15 18'] },
  search: { paths: ['M14.5 14.5L20 20'], circles: [[10, 10, 6]] },
  // A clock face: routines and anything on a schedule.
  clock: { paths: ['M12 7V12H16'], circles: [[12, 12, 9]] },
  pen: { paths: ['M4 20V16L15 5L19 9L8 20Z'] },
  // An arrow out to a line: outreach.
  send: { paths: ['M3 12H17M12 7L17 12L12 17M21 5V19'] },
  chat: { paths: ['M4 5H20V16H11L7 20V16H4Z'] },
  grid: { paths: ['M4 4H10V10H4ZM14 4H20V10H14ZM4 14H10V20H4ZM14 14H20V20H14Z'] },
  // A banknote: money, invoices, the books.
  money: { paths: ['M3 6H21V18H3Z', 'M6 9V15M18 9V15'], circles: [[12, 12, 3]] },
  calendar: { paths: ['M4 6H20V20H4Z', 'M4 10H20', 'M8 3V7M16 3V7'] },
  people: {
    paths: ['M3 20V17L5 15H11L13 17V20', 'M16 15H19L21 17V20'],
    circles: [
      [8, 9, 3],
      [17.5, 10, 2],
    ],
  },
  shield: { paths: ['M4 4H20V12L12 20L4 12Z', 'M12 4V20'] },
  globe: { paths: ['M3 12H21', 'M12 3V21', 'M5 7.5H19M5 16.5H19'], circles: [[12, 12, 9]] },
  megaphone: { paths: ['M3 9H7L13 3V21L7 15H3Z', 'M17 9V15M20 7V17'] },
  // A ticked box: checks and QA.
  check: { paths: ['M3 3H21V21H3Z', 'M7 12L10 15L17 8'] },
  // A box with its lid: moving, shipping, stock.
  box: { paths: ['M4 8H20V20H4Z', 'M4 8L8 4H16L20 8', 'M10 12H14'] },
  car: {
    paths: ['M3 16V12L5 10L8 7H16L19 10L21 12V16H3Z', 'M5 10H19'],
    circles: [
      [7.5, 17, 2],
      [16.5, 17, 2],
    ],
  },
  bolt: { paths: ['M15 3L9 9H15L9 15H15L9 21'] },
  mic: { paths: ['M9 3H15V14H9Z', 'M6 11V14L9 17H15L18 14V11', 'M12 17V21M8 21H16'] },
  chart: { paths: ['M4 4V20H20', 'M8 16V12M12 16V8M16 16V10'] },
  doc: { paths: ['M6 3H14L18 7V21H6Z', 'M14 3V7H18', 'M9 12H15M9 16H15'] },
};
