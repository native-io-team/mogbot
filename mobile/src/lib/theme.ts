/**
 * The app's tokens, for React Native. The names are the desktop's semantic
 * roles (src/styles/global/tokens-semantic.css), so `colors.surfacePanel` is
 * `--surface-panel`. The neutrals are the site's (mogbot-site global.css):
 * warm paper, chalk and ink in light, the dark keys' charcoal in dark, so the
 * phone reads as the brand people saw before they installed it. The semantic
 * colours (success, warning, error, focus) are the desk's.
 *
 * Two layers, as MISSION asks ("black and white, plus one accent"):
 *
 * - The **palette** here is fixed per appearance: greys, and the semantic
 *   colours whose meaning never changes (success, warning, error, focus). It
 *   has no accent.
 * - The **accent** is derived at runtime from an agent's colour
 *   (lib/accent.tsx): the Chief of Staff's across the app, each agent's
 *   inside its own chat, as Grok Bot does.
 *
 * Every colour a screen draws comes from one of the two; there are no colour
 * literals outside this file (a test holds that). Screens never import a
 * palette: they read the one in use from `useColors()` / `makeStyles()`
 * (lib/appearance.tsx), which follows the system, or the phone's own setting.
 */

export interface Palette {
  surfaceApp: string;
  surfacePanel: string;
  surfaceControl: string;
  surfaceControlHover: string;
  surfaceSelected: string;
  /** Your own messages. Dark lifts them to the selected grey; light keeps them a quiet step off white, as iMessage's grey is. */
  surfaceBubble: string;
  /** The strongest text: titles, names, what must be read first. White in dark, near-black in light. */
  textStrong: string;
  /** What people read: message bodies, a step stronger than the chrome. */
  textBody: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textFaint: string;
  /** Ink on a light fill (a light accent). */
  inkDark: string;
  /** Ink on a dark fill (a dark accent). */
  inkLight: string;
  /**
   * A selected chip or segment: the neutral ink as a fill (near-black in
   * light, near-white in dark), so which one is on reads at a glance in both.
   * A grey step on grey (1.15:1 in light) didn't.
   */
  selectedFill: string;
  /** Words on `selectedFill`. */
  onSelectedFill: string;
  /** The one divider: between rows in a group, around a well in prose, under a pinned bar. */
  borderDefault: string;
  /** Fainter than the divider, for a line that should barely register. */
  borderSubtle: string;
  /** Interactive outlines only (a focused field). Never a card. */
  borderStrong: string;
  /**
   * A grouped list on a sheet (Settings, the agent sheet, the diff's files): one
   * step toward the viewer from the sheet behind it, the iOS grouped idiom.
   */
  surfaceGroup: string;
  /**
   * The one border a card may have: one hairline in either appearance. In
   * light it is the site's card ring, which keeps a card crisp on paper; in
   * dark the fill step alone (1.07:1) doesn't carry it.
   */
  cardBorder: string;
  /** A pressed row inside a group. */
  surfaceGroupPressed: string;
  /** The message field and the + beside it: a fill in dark, a fill and a hairline in light. */
  composerFill: string;
  composerBorder: string;
  /** A text field in a card or on a sheet: clearly a field on a panel, in either appearance. */
  inputFill: string;
  inputBorder: string;
  /** Outcomes only ("Allowed", a diff's additions, "Finished"). Never an action. */
  accentSuccess: string;
  /** Something under way (you driving an agent on the Mac, an import): --status-running, never the accent. */
  statusRunning: string;
  accentWarning: string;
  /** Words on a warning fill (the "Needs your OK" pill): dark on dark's bright amber, white on light's deep one. */
  onWarning: string;
  accentError: string;
  /** Error as words and glyphs (a destructive row, a failed line). */
  accentErrorLight: string;
  accentFocus: string;
  /** The neutral accent: what an agent coloured "white" (and the Chief, by default) takes. */
  accentNeutral: string;
  /**
   * A count on a tab (Needs you): neutral like the desk's bell, never system
   * red. iOS draws its badge text white whatever is asked, so the fill is a
   * dark neutral in both themes, white on it at AA.
   */
  badgeFill: string;
  badgeInk: string;
  /** A diff's added and removed lines: ink, and the band behind the line. */
  diffAdd: string;
  diffAddBg: string;
  diffDel: string;
  diffDelBg: string;
  /** Behind a menu or a dialog, over the app. */
  scrim: string;
  /** On a photo or the camera, in either appearance: white words, a dark scrim, the viewfinder. */
  onMedia: string;
  mediaScrim: string;
  overlayFrame: string;
  /** Behind a photo, as the system viewer has it, in either appearance. */
  black: string;
  /**
   * A chart's series, in fixed order (blocks, `components/blocks`): the agent
   * keys' hues (blue, orange, teal, mustard, pink, green, violet, brick),
   * stepped per appearance and validated as a set (the dataviz method: the
   * lightness band, chroma, colour-blind separation of neighbours, 3:1 on
   * the app, a panel and a control in both appearances). The desk's `--chart-series-1…8` are the same values.
   * Marks only: words beside them stay in text roles.
   */
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  chart6: string;
  chart7: string;
  chart8: string;
}

/** Shared by both: what sits on a photo or the camera doesn't change with the app around it. */
const media = {
  onMedia: '#ffffff',
  mediaScrim: 'rgba(0, 0, 0, 0.75)', // --color-black-o75
  overlayFrame: 'rgba(255, 255, 255, 0.85)', // --color-white-o85
  black: '#000000', // --color-black
} as const;

const dark: Palette = {
  // Warm charcoal, the site's dark keys, step for step the desk's warm grey
  // ramp (tokens-core.css --color-gray-*; docs/internal/brand-direction.md),
  // so desk, phone and site read as one brand.
  surfaceApp: '#151413',
  surfacePanel: '#1c1b19',
  surfaceControl: '#292725',
  surfaceControlHover: '#31302d',
  surfaceSelected: '#3a3835',
  surfaceBubble: '#3a3835',
  textStrong: '#ffffff',
  // A reply is read in near-white with a warm cast: a whole reply in the
  // chrome's grey read dim next to Grok's and iMessage's bodies.
  textBody: '#ebe8e3',
  textPrimary: '#d6d2ca',
  textSecondary: '#a29d95',
  // The desk's --text-muted (#7a766f) is 3.5:1 on a control: too faint for
  // words read outdoors. The phone's sits just under textSecondary, so it
  // still passes 4.5:1 where placeholders and metadata sit on a fill: a
  // control and a group (4.7), the message field.
  textMuted: '#959088',
  // Decoration only (rules, chevrons, a disabled glyph), never words.
  textFaint: '#4f4c48',
  inkDark: '#151413',
  inkLight: '#ffffff',
  selectedFill: '#f4f2ee',
  onSelectedFill: '#151413',
  // Named by how much they show: the desktop's --border-subtle is the firmer
  // of its two, so the phone's names are the other way round.
  borderDefault: '#31302d',
  borderSubtle: '#242220',
  borderStrong: '#3a3835',
  surfaceGroup: '#292725',
  cardBorder: '#292725',
  surfaceGroupPressed: '#31302d',
  composerFill: '#242220',
  composerBorder: 'transparent',
  inputFill: '#151413',
  inputBorder: '#3a3835',
  accentSuccess: '#35d35d', // --accent-success (green-600)
  statusRunning: '#6bb5ff', // --status-running (blue-400)
  accentWarning: '#e89a1c', // --accent-warning (orange-600)
  onWarning: '#151413',
  accentError: '#f44747', // --accent-error
  accentErrorLight: '#ef4444', // --accent-error-light
  accentFocus: '#2792ff', // --accent-focus (blue-500)
  accentNeutral: '#ebe8e3', // --agents-tint-white, warmed as textBody
  badgeFill: '#5b5850',
  badgeInk: '#ffffff',
  diffAdd: '#35d35d',
  diffAddBg: 'rgba(53, 211, 93, 0.1)',
  diffDel: '#ef4444',
  diffDelBg: 'rgba(244, 71, 71, 0.1)',
  scrim: 'rgba(0, 0, 0, 0.75)', // --color-black-o75
  chart1: '#5a86e6',
  chart2: '#e86a34',
  chart3: '#2fa493',
  chart4: '#b8860b',
  chart5: '#d46685',
  chart6: '#3f9443',
  chart7: '#9580e0',
  chart8: '#d9604a',
  ...media,
};

/**
 * Light is drawn for light, not inverted from dark. Paper-white for the app
 * and its chats (what's read most sits on the brightest surface), and each
 * step of layering a few percent darker: panels and cards recess rather than
 * glow. Words are near-black, never pure black, and every grey that carries
 * words passes 4.5:1 on app, panel and control. Hairlines are a touch firmer
 * than dark's, because on white a 1px line is all that separates two greys.
 * The semantic colours are their deeper shades (green-700, amber-700, red-700
 * and so on): the bright ones the dark palette uses wash out on white.
 */
const light: Palette = {
  // The desk's warm paper ramp (tokens-core.css --color-paper-*, from the
  // site's paper and chalk; --fill #f1efeb for your bubble). The phone keeps
  // its own order: warm white where things are read, each layer a step
  // darker, so panels and cards recess like the site's trays rather than glow.
  surfaceApp: '#fdfcfa',
  surfacePanel: '#f4f2ee',
  surfaceControl: '#efede8',
  surfaceControlHover: '#e9e6e0',
  surfaceSelected: '#e3dfd8',
  surfaceBubble: '#f1efeb',
  // The desk's ink (--color-ink-900, -800, -700, -600, -525).
  textStrong: '#1c1c1c',
  textBody: '#2c2a27',
  textPrimary: '#403d39',
  textSecondary: '#55524b',
  // 5.9:1 on a control (placeholders sit there), 6.2 on a panel.
  textMuted: '#5e5a53',
  // Decoration only, as in dark.
  textFaint: '#cbc6bd',
  inkDark: '#1c1c1c',
  inkLight: '#ffffff',
  selectedFill: '#1c1c1c',
  onSelectedFill: '#ffffff',
  borderDefault: '#e3dfd8',
  borderSubtle: '#e9e6e0',
  borderStrong: '#cbc6bd',
  surfaceGroup: '#fdfcfa',
  // The site's card ring (0 0 0 1px #00000012): a hairline that keeps a
  // card crisp on paper, where the fill step alone (1.04:1) went soft.
  cardBorder: '#e3dfd8',
  surfaceGroupPressed: '#efede8',
  composerFill: '#f4f2ee',
  composerBorder: '#e3dfd8',
  inputFill: '#fdfcfa',
  inputBorder: '#cbc6bd',
  accentSuccess: '#2f7349', // the site's --live
  statusRunning: '#0a63c9', // --status-running (blue-800)
  // Amber-700 a step deeper: 4.5:1 on the warm panel too.
  accentWarning: '#ad4f08',
  onWarning: '#ffffff',
  accentError: '#d42a20',
  accentErrorLight: '#c4261c',
  accentFocus: '#0b6bdc',
  // The neutral accent in light is ink: a white Chief on a white app would be invisible.
  accentNeutral: '#1c1c1c',
  badgeFill: '#1c1c1c',
  badgeInk: '#ffffff',
  diffAdd: '#11672f',
  diffAddBg: 'rgba(21, 128, 61, 0.1)',
  diffDel: '#b0221a',
  diffDelBg: 'rgba(212, 42, 32, 0.08)',
  scrim: 'rgba(29, 28, 26, 0.24)',
  chart1: '#3f6fd8',
  chart2: '#db632b',
  chart3: '#2c9688',
  chart4: '#ac7f19',
  chart5: '#c56b87',
  chart6: '#3e8a3e',
  chart7: '#7357c9',
  chart8: '#c2452c',
  ...media,
};

/** A chart series' colour by its slot (1-based, from `slotOf`). */
export const seriesColor = (colors: Palette, slot: number): string =>
  [
    colors.chart1,
    colors.chart2,
    colors.chart3,
    colors.chart4,
    colors.chart5,
    colors.chart6,
    colors.chart7,
    colors.chart8,
  ][Math.max(0, Math.min(7, slot - 1))];

/**
 * A block's chart (`components/blocks/BlockChart.tsx`): its height, a
 * sparkline's, the 2pt line, the end dot's radius and its surface ring, and
 * the area wash's opacity (the dataviz spec: thin marks, a 10% wash).
 */
export const chartSize = {
  height: 180,
  pie: 168,
  spark: 28,
  sparkWidth: 72,
  line: 2,
  dot: 4,
  ring: 2,
  wash: 0.1,
  swatch: 8,
  tooltip: 168,
} as const;

export const palettes = { dark, light } as const;

/**
 * Depth, as the desk draws it (tokens-semantic.css --shadow-card,
 * tokens-components.css --tabs-tray-* / --tabs-key-*): a card is a sheet (a
 * long soft drop pulled in under it; on dark a lit top edge as well), a
 * segmented control is a recessed tray with a raised key on it. `boxShadow`
 * strings; the fills are the key's and the tray's own. Read through
 * `depthOf(colors)`.
 */
const depthByAppearance = {
  dark: {
    card: 'inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 8px 24px -12px rgba(0, 0, 0, 0.5)',
    tray: 'inset 0 1px 2px rgba(0, 0, 0, 0.5), inset 0 -1px 0 rgba(255, 255, 255, 0.05)',
    trayFill: '#151413', // --tabs-tray-surface (surface-app)
    key: 'inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 0.5px rgba(0, 0, 0, 1), 0 1px 0 rgba(21, 20, 19, 1), 0 2px 4px rgba(0, 0, 0, 0.3)',
    keyFill: '#3a3835', // --color-gray-750
    // A filled button's keycap (base.css .button--primary/--strong): its lit
    // top edge and the soft drop under its side (--button-key-lit/-drop).
    capLit: 'rgba(255, 255, 255, 0.22)',
    capDrop: 'rgba(0, 0, 0, 0.5)',
    // How far `card` reaches past the card (8 + 24 − 12 = 20, rounded up):
    // what a wrapper that ends at the card, or a clipping parent, must leave
    // below it, or the shadow stops in a hard line (--shadow-card-reach).
    cardReach: 24,
  },
  light: {
    card: '0 24px 32px -24px rgba(0, 0, 0, 0.3), 0 6px 12px -8px rgba(0, 0, 0, 0.15)',
    tray: 'inset 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 -1px 0 rgba(255, 255, 255, 0.7)',
    trayFill: '#e6e2db', // between --color-paper-250 and -200, the tray's gradient
    key: '0 0 0 0.5px rgba(0, 0, 0, 0.12), 0 1px 0 rgba(203, 198, 189, 1), 0 2px 4px rgba(0, 0, 0, 0.08)',
    keyFill: '#ffffff',
    capLit: 'rgba(255, 255, 255, 0.15)',
    capDrop: 'rgba(0, 0, 0, 0.12)',
    // 24 + 32 − 24 = 32.
    cardReach: 32,
  },
} as const;

export type Depth = (typeof depthByAppearance)[Appearance];

/** The depth for the palette in force. */
export const depthOf = (colors: Palette): Depth =>
  colors === palettes.dark ? depthByAppearance.dark : depthByAppearance.light;

/** How far a keycap's side sits below its face, and how far a press moves it (the desk's 2 and 1). */
export const KEY_DEPTH = 2;
export const KEY_TRAVEL = 1;
/** The side's shade: the face mixed toward black by this much (accent.ts KEY_SIDE_SHADE). */
export const KEY_SIDE_SHADE = 0.2;

/** A keycap's side for a fill: always darker, even under a near-black key (a lit side reads as a glow). */
export const keySide = (fill: string): string => mix(fill, '#000000', 1 - KEY_SIDE_SHADE);

/**
 * A filled button as a keycap: lit top edge, a short side in the key's own
 * shade, a soft drop. Pressed, the face travels down by what the side gives
 * up, so the key's bottom edge (and everything below it) stays put.
 */
export function keycapShadow(depth: Depth, side: string, pressed: boolean): string {
  const d = pressed ? KEY_DEPTH - KEY_TRAVEL : KEY_DEPTH;
  return pressed
    ? `inset 0 1px 0 ${depth.capLit}, 0 ${d}px 0 ${side}, 0 0 2px ${depth.capDrop}`
    : `inset 0 1px 0 ${depth.capLit}, 0 ${d}px 0 ${side}, 0 ${d}px 4px ${depth.capDrop}`;
}

/** A status pill's wash: its hue at this alpha (the desk's --status-pill-wash). */
export const PILL_WASH = 0.14;
/** A status pill's dot (the desk's --status-pill-dot). */
export const PILL_DOT = 6;

/**
 * Something new arriving (a message, a card, a row): the site's arrive
 * curve, 200 ms at most (the desk's --transition-arrive), an 8pt rise.
 */
export const ARRIVE = { ms: 200, rise: 8, curve: [0.16, 1, 0.3, 1] } as const;
export type Appearance = keyof typeof palettes;
export const APPEARANCES = Object.keys(palettes) as Appearance[];

/**
 * `--agents-tint-*` in src/styles/features/agents.css, keyed like
 * `Agent.color`, per appearance. Each is also an accent (lib/accent.tsx).
 * "white" isn't here: it is the palette's `accentNeutral`, one rule in
 * accent.tsx. Light takes each hue's deeper shade, so it reads as words
 * (4.5:1 on the app and a panel) and carries white ink as a fill.
 */
export const agentTints: Record<Appearance, Record<string, string>> = {
  dark: {
    brown: '#b08560',
    red: '#ef5b50',
    orange: '#f07c3c',
    amber: '#e9a83a',
    green: '#3fbf6a',
    teal: '#2fb3a1',
    blue: '#4d8ff5',
    purple: '#9471f5',
    pink: '#e45a9f',
    gray: '#8a8a8a',
  },
  light: {
    brown: '#8a5a33',
    red: '#c4342a',
    orange: '#b64a0c',
    amber: '#9c6200',
    green: '#187d41',
    teal: '#0e7a6d',
    blue: '#2563d6',
    purple: '#6d45dc',
    pink: '#bf3580',
    gray: '#6b6b6b',
  },
};

/**
 * Every `Agent.color` key, in the desk's order (`store::COLORS`): the neutral
 * one, then the tints above. A new agent starts on the first that nobody
 * wears, never on the two left for you to pick, and on the fallback when
 * all are taken (the desk's `freeColor`).
 */
export const agentColorKeys = {
  all: ['white', ...Object.keys(agentTints.dark)],
  pickedOnly: ['white', 'gray'],
  fallback: 'purple',
} as const;

/** Each colour key in words, for VoiceOver: what the swatch looks like, not its key. */
export const agentColorNames: Record<string, string> = {
  white: 'Neutral',
  brown: 'Brown',
  red: 'Red',
  orange: 'Orange',
  amber: 'Amber',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  gray: 'Gray',
};

/** `--spacing-*`. */
/** The least a finger is given (Apple's 44pt, Android's 48dp sits inside its padding). */
export const MIN_TAP = 44;

/** A control drawn `height` tall, given a whole tap above and below it. */
export const tapSlop = (height: number) => {
  const v = Math.max(0, Math.ceil((MIN_TAP - height) / 2));
  return { top: v, bottom: v };
};

/** A chip's drawn height: under `MIN_TAP`, so a chip carries `tapSlop(CHIP_H)`. */
export const CHIP_H = 36;

export const space = {
  '3xs': 1,
  '2xs': 2,
  xs: 4,
  tight: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
} as const;

/**
 * Corners. One card radius, and an inner radius concentric with it: a well
 * inside a 16-padded card is `card − padding / 2`, so the two curves share a
 * centre. Nothing draws a corner that isn't one of these, a circle (`size / 2`)
 * or a squircle (`squircle(size)`); a test holds that.
 *
 * - `inner`: wells inside a card (a command, a diff, code, a table), text
 *   inputs, small badges.
 * - `control`: buttons, icon wells, composer tiles.
 * - `card`: every card, group, chip, thumbnail, toast and summary bar.
 * - `sheet`: sheets, native and our own menu.
 */
export const radius = {
  sm: 4,
  /** A status pill: the site's 6px tag. */
  tag: 6,
  inner: 10,
  control: 12,
  card: 16,
  sheet: 24,
  pill: 999,
} as const;

/** A logo's or tile's corner: one squircle proportion at every size. */
export const squircle = (size: number) => Math.round(size * 0.28);

/**
 * Icon sizes. Four, and one exception:
 * - `inline` 12: beside a caption or small line (every chevron, pin, lock, eyebrow glyph).
 * - `body` 16: beside body text (row icons, button icons, the composer's glyphs).
 * - `button` 20: an IconButton's glyph in its 44pt target.
 * - `hero` 28: an empty state.
 * - `micro` 10: only the × on a tile too small for 12.
 */
export const iconSize = { micro: 10, inline: 12, body: 16, button: 20, hero: 28 } as const;

/**
 * The typing dots (`components/TypingDots.tsx`), the desktop's
 * `--typing-dots-*`: 5pt dots 4 apart (three of them span about an inline
 * icon and a half), lifting 1.5pt at the crest.
 */
export const typingDot = { size: 5, gap: space.xs, lift: 1.5 } as const;

/**
 * The independence slider (`components/IndependenceSlider.tsx`), the desk's
 * `--independence-slider-*`: a 4pt track, 8pt stop dots and a 24pt thumb in
 * a 44pt touch row.
 */
export const levelSlider = { track: 4, tick: 8, thumb: 24, row: 44 } as const;

/**
 * The message field, as Claude's own: one capsule of the system's glass
 * (components/Glass.tsx), like the tab bar's. Empty or one line it's a 48pt
 * pill with everything inside it: the + at the left, the words, then the
 * mic, Stop and send at the right, each a 40pt circle 4pt in from the edge
 * (concentric with the 24pt corner). Once the words wrap, or there are files
 * or it's listening, it becomes a card with the same 24pt corner: files on
 * top, the words across its whole width, and the buttons in a row under them.
 * Every one of them is a 44pt target or more.
 *
 * `line` and `corner` are the user bubble's (components/chat.tsx), which
 * keeps iMessage's 20pt line and 18pt corner; the field has its own.
 */
export const composer = {
  /** The bubble's 16pt text on a 20pt line. */
  line: 20,
  /** The bubble's corner. */
  corner: 18,
  /** The field's 17pt text (`type.field`) on a 22pt line. */
  fieldLine: 22,
  /** Above and below the text, so one line is 48. */
  padV: 13,
  padLeft: 18,
  padRight: 8,
  /** From the + to the words beside it, in the pill. */
  afterLead: 8,
  height: 48,
  fieldCorner: 24,
  /** Lines before it scrolls inside. */
  maxLines: 6,
  /**
   * Past six lines the words scroll inside and the lines leaving at the top
   * fade out over this much (the top padding and most of a line), in
   * `fadeBands` steps of the field's own fill, rather than being cut.
   */
  fade: 24,
  fadeBands: 12,
  send: 40,
  /** Send's inset from the field's edge. */
  inset: 4,
  /**
   * Between the field and the keyboard when it's up. With it down the field
   * sits on the home indicator's inset; up, the sticky view gives that inset
   * back down to this, so the field never touches the keys.
   */
  keyboardGap: 10,
  /**
   * Dictating, the field is a card (as Claude's own dictation): the words
   * across its whole width on top with a caret after the last one, and under
   * them a row of ×, the waveform, Stop and Send. The caret is the system
   * caret's 2pt bar, a little shorter than the line, dropped to sit on the
   * descender as a text input's does. It blinks at `caretBlink` per half.
   */
  caretWidth: 2,
  caretHeight: 20,
  caretDrop: 4,
  caretBlink: 530,
} as const;

/**
 * Where a conversation meets the composer (and the header): the words fade
 * out over this height instead of stopping on a hard edge, in `fadeBands`
 * steps of the chat's own background. The list keeps this much room at its
 * newest end, so at the bottom the fade sits on empty space, never on the
 * last message.
 */
export const chatFade = { height: 28, bands: 14 } as const;

/**
 * The dictation waveform (`components/Waveform.tsx`), in the dictation card's
 * bottom row between × and Stop (under the words, never beside them: there it
 * squeezed them to a few per line): 2pt bars 2pt apart, a dot at silence and
 * 18pt at full voice. It fills the row, as many bars as fit; `bars` is the
 * count where it has a fixed width. Under Reduce Motion a 2pt-thick meter of
 * the same width stands in.
 */
export const waveform = {
  bars: 12,
  bar: 2,
  gap: 2,
  min: 2,
  max: 18,
  /** The left edge fades in over this much, so bars arrive and leave softly. */
  fade: 16,
} as const;

/** The round mark an empty or finished screen leads with (a tick in a circle). */
export const heroMark = 56;

/**
 * Agent keys (docs/internal/agent-keys.md; components/AgentKey.tsx): every
 * agent is a keycap. Its sizes are the desk's (`AgentKey`'s `size`): a line
 * of text, a menu item or a group, a list row's small key, a header, and the
 * big key with its sublegend and pips (the agent sheet).
 */
export const keySize = { xs: 16, sm: 20, md: 30, lg: 44, xl: 112 } as const;

/** A key's three shades (face, skirt, depth) and its legend's ink. */
export interface KeyColors {
  face: string;
  skirt: string;
  depth: string;
  legend: string;
}

/**
 * The fourteen colourways, value for value with the shared `agent-keys.json`
 * (theme.node.test holds them equal). Keys keep their colours in both
 * appearances; only the socket and the shadow under them follow it.
 */
export const keyColorways: Record<string, KeyColors> = {
  blue: { face: '#3f6fd8', skirt: '#3159b4', depth: '#223f85', legend: '#ffffff' },
  orange: { face: '#ec6a2e', skirt: '#c9521c', depth: '#8f3810', legend: '#1f1005' },
  putty: { face: '#e6decc', skirt: '#cbc1ab', depth: '#a0967f', legend: '#2a2722' },
  teal: { face: '#6fc2b6', skirt: '#52a398', depth: '#33756c', legend: '#0c2421' },
  graphite: { face: '#4a4e55', skirt: '#34373c', depth: '#131417', legend: '#f2eee4' },
  mustard: { face: '#e8b93f', skirt: '#c99a26', depth: '#8e6b12', legend: '#2a1e05' },
  pink: { face: '#efa9a2', skirt: '#d48a83', depth: '#9c5c56', legend: '#2b0e0c' },
  sage: { face: '#a9ba78', skirt: '#8c9d5c', depth: '#5f6e38', legend: '#1a2108' },
  brick: { face: '#b5452c', skirt: '#963722', depth: '#632314', legend: '#fff1e8' },
  plum: { face: '#7a3e6e', skirt: '#62305a', depth: '#3f1c3a', legend: '#fbeaf5' },
  navy: { face: '#27395e', skirt: '#1d2c4a', depth: '#0e172c', legend: '#eee7d8' },
  forest: { face: '#2f6148', skirt: '#244d39', depth: '#123021', legend: '#eaf2e2' },
  sky: { face: '#9dc8ea', skirt: '#7eabd0', depth: '#4c7ba3', legend: '#0e2538' },
  lilac: { face: '#c3b4e2', skirt: '#a696c8', depth: '#6c5d95', legend: '#1f1734' },
};

/**
 * A key's light (the site's keys; the desk's agent-key.css): the warm white
 * of a lit legend (working, live) and its glow; the amber-gold of Needs your
 * OK, the loudest state, and its spill; the light breathing in a working
 * face; the washes that light a cap from above and shade its foot.
 */
export const keyLit = {
  legend: '#ffe9b4',
  glow: '#ffd47a',
  ask: '#ffc94a',
  askGlow: '#ffaa28',
  askSpill: '#ffb02e',
  askFace: '#ffc450',
  breath: '#ffe3a0',
  spillWarm: '#ffe9b0',
  white: '#ffffff',
  black: '#000000',
  /** The hairline of light along a face's top edge. */
  shine: 'rgba(255, 255, 255, 0.22)',
} as const;

/** What follows the theme under a key: its soft ambient shadow, the empty socket and its stem, the spill's strength, a paused cap's fade. */
export interface KeyNeutrals {
  ambient: string;
  ambientOpacity: number;
  socketTop: string;
  socketBottom: string;
  socketShade: string;
  socketRim: string;
  stem: string;
  stemDepth: string;
  spill: number;
  pausedOpacity: number;
}

export const keyNeutrals: Record<'dark' | 'light', KeyNeutrals> = {
  dark: {
    ambient: '#000000',
    ambientOpacity: 0.45,
    socketTop: '#191816',
    socketBottom: '#2a2824',
    socketShade: 'rgba(0, 0, 0, 0.55)',
    socketRim: 'rgba(255, 255, 255, 0.1)',
    stem: '#6e6a61',
    stemDepth: '#45423c',
    spill: 0.42,
    pausedOpacity: 0.5,
  },
  light: {
    ambient: '#2a2014',
    ambientOpacity: 0.22,
    socketTop: '#cdc4b2',
    socketBottom: '#d8d0bf',
    socketShade: 'rgba(0, 0, 0, 0.2)',
    socketRim: 'rgba(255, 255, 255, 0.63)',
    stem: '#bdb4a2',
    stemDepth: '#968c78',
    spill: 0.5,
    pausedOpacity: 0.55,
  },
};

/** A colour with its saturation cut to `keep` (0 grey, 1 itself), as CSS `saturate()` does. */
export function saturate(hex: string, keep: number): string {
  const [r, g, b] = parseHex(hex);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const c = [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(l + (v - l) * keep))));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The desktop's type scale (`--font-size-*`), one step up where the desk
 * reads at arm's length and a phone at hand's: body 16 (T3 and most chat
 * apps sit at 16-17), subtitles 14, captions 12 for metadata only. `read` is
 * what a conversation is written in (a reply, your bubble): 17, Grok's and
 * iMessage's size, on the roomier `READ_LINE`.
 *
 * These are the sizes at the Default text size. Settings → Text size scales
 * every one of them (`TEXT_SIZES`), on top of Dynamic Type, which iOS applies
 * to whatever size a Text asks for. `type` reads the size in force each time
 * it's read, so a stylesheet built through `makeStyles` (rebuilt when the
 * size changes) picks it up.
 */
export const baseType = {
  caption: 12,
  small: 14,
  body: 16,
  /** The message field's words: iOS's own body size, a step up from a message's. */
  field: 17,
  subhead: 16,
  read: 17,
  /** A reply's top heading: a step over `title`, so a `#` reads over a `##`. */
  heading: 20,
  title: 18,
  display: 28,
  /** Tile labels only (a file's extension on a 40pt badge): never a sentence. */
  micro: 10,
} as const;

export type TypeRole = keyof typeof baseType;

/** Settings → Text size: the phone's own step, multiplied into every size. */
export const TEXT_SIZES = {
  smaller: 0.88,
  default: 1,
  larger: 1.12,
  largest: 1.25,
} as const;
export type TextSize = keyof typeof TEXT_SIZES;
export const TEXT_SIZE_KEYS = Object.keys(TEXT_SIZES) as TextSize[];

let textScale: number = TEXT_SIZES.default;

/** The multiplier for a saved choice; anything unknown is Default. */
export const textScaleOf = (size: string | undefined): number =>
  (size && TEXT_SIZES[size as TextSize]) || TEXT_SIZES.default;

/** Sets the multiplier `type` reads (the AppearanceProvider does). True when it changed. */
export function setTextScale(size: string | undefined): boolean {
  const next = textScaleOf(size);
  if (next === textScale) return false;
  textScale = next;
  return true;
}

/** Runs `build` with `type` read at `scale`: a stylesheet built for a theme, whatever is in force. */
export function atTextScale<R>(scale: number, build: () => R): R {
  const before = textScale;
  textScale = scale;
  try {
    return build();
  } finally {
    textScale = before;
  }
}

/** A size from the base scale at the text size in force, on whole points. */
export const scaledSize = (base: number, scale = textScale) => Math.round(base * scale);

/** The type scale at the text size in force. Read it when a style is built; don't keep it. */
export const type = Object.defineProperties(
  {},
  Object.fromEntries(
    (Object.keys(baseType) as TypeRole[]).map((role) => [
      role,
      { enumerable: true, get: () => scaledSize(baseType[role]) },
    ])
  )
) as Readonly<Record<TypeRole, number>>;

/** A conversation's line: 1.55× (17 on 26), the air Grok's replies have. */
export const READ_LINE = 1.55;

/**
 * How far chrome may grow with Dynamic Type before it would crowd out what
 * it frames: titles, pills and buttons.
 */
export const chromeScale = 1.3;

/**
 * Message bodies reflow, so they grow much further than chrome, but not
 * without end: at the largest accessibility sizes (×3 and more) a 17pt reply
 * sets two words a line. Clamped at ×2 it still reads at AX3.
 */
export const READ_MAX_SCALE = 2;

/**
 * A card's title and its asides: they may grow further than chrome, but not
 * so far that the answers under them leave the screen.
 */
export const CARD_TITLE_SCALE = 1.5;

/**
 * Dynamic Type from which a row stops sharing its line (accessibility
 * sizes start at ×1.6 on iOS): words over the full width, the action under
 * them, rather than both squeezed and the words cut short.
 */
export const LARGE_TEXT = 1.6;

export const lineHeight = (size: number, ratio = 1.4) => Math.round(size * ratio);

/**
 * Tracking, in ems, as the desk sets Geist (--tracking-name -0.01em,
 * --tracking-title -0.02em, --tracking-hero -0.035em), after the site's tight
 * headlines: names and titles pulled in, running text left as drawn.
 */
export const tracking = {
  display: -0.035,
  title: -0.02,
  headline: -0.01,
  subhead: -0.006,
} as const;

/** Letter spacing in points for a size and a tracking, to a hundredth. */
export const track = (size: number, em: number) => Math.round(size * em * 100) / 100;

export const fonts = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  mono: 'GeistMono_400Regular',
} as const;

/** `color-mix(in srgb, a p%, b)`. */
export function mix(a: string, b: string, p: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const c = ca.map((v, i) => Math.round(v * p + cb[i] * (1 - p)));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance of a hex colour: 0 is black, 1 white. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two hex colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A speaker's name in its agent's colour: the tint pulled 30% toward the text
 * colour (the desk's `color-mix` on `.agent-room__speaker-name`). If that
 * still falls under 4.5:1 on `on`, it moves toward the text until it clears,
 * so a name is always words you can read, never a pale hue.
 */
export function speakerInk(tint: string, text: string, on: string): string {
  for (let share = 0.7; share >= 0; share -= 0.1) {
    const ink = mix(tint, text, share);
    if (contrast(ink, on) >= 4.5) return ink;
  }
  return text;
}

/** `rgba()` of a hex colour, for tints and glows. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function parseHex(hex: string): number[] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** `--duration-*`. */
export const duration = { fast: 100, standard: 150, slow: 300 } as const;

/** What a pressed text control, pill or icon looks like: the same everywhere, from the first frame of the press. */
export const PRESSED = { opacity: 0.6 } as const;

/**
 * What a rewind passed over, opened: muted, behind a rule on its left, so it
 * reads as past. The desk's `.agent-go-back__summary[data-open] ~ …` is the
 * same 0.55 and the same 2px rule in its default border.
 */
export const PAST = { opacity: 0.55, rule: space['2xs'] } as const;
