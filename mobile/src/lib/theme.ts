/**
 * The app's tokens, for React Native. Values are copied from the desktop's
 * token layers (src/styles/global/tokens-core.css → tokens-semantic.css); the
 * names are the semantic roles, so `colors.surfacePanel` is `--surface-panel`.
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
   * The one border a card may have. None in light, where the fill step carries
   * it; one hairline in dark, where the fill step alone (1.07:1) doesn't.
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
}

/** Shared by both: what sits on a photo or the camera doesn't change with the app around it. */
const media = {
  onMedia: '#ffffff',
  mediaScrim: 'rgba(0, 0, 0, 0.75)', // --color-black-o75
  overlayFrame: 'rgba(255, 255, 255, 0.85)', // --color-white-o85
  black: '#000000', // --color-black
} as const;

const dark: Palette = {
  surfaceApp: '#141414', // --surface-app (gray-950)
  surfacePanel: '#1a1a1a', // --surface-panel (gray-900)
  surfaceControl: '#282828', // --surface-control (gray-850)
  surfaceControlHover: '#303030', // --surface-control-hover (gray-800)
  surfaceSelected: '#393939', // --surface-selected (gray-750)
  surfaceBubble: '#393939',
  textStrong: '#ffffff',
  // Between --color-gray-100 and -200: a whole reply in #bcbcbc read dim next
  // to Grok's and iMessage's near-white bodies. Chrome keeps textPrimary.
  textBody: '#e6e6e6',
  textPrimary: '#bcbcbc', // --text-primary (gray-200)
  textSecondary: '#979797', // --text-secondary (gray-400)
  // --text-muted is gray-600 on the desk, 4.06:1 on these surfaces: too faint
  // for words read outdoors at 12-14pt. The phone's sits just under
  // textSecondary, so it still passes 4.5:1 where placeholders and metadata
  // sit on a fill: a control (4.5), a group (4.6), the message field (4.8).
  textMuted: '#8e8e8e',
  // Decoration only (rules, chevrons, a disabled glyph), never words: 2.2:1.
  textFaint: '#4e4e4e', // --text-faint (gray-700)
  inkDark: '#141414', // --text-on-accent
  inkLight: '#ffffff',
  selectedFill: '#ededed',
  onSelectedFill: '#141414',
  // Named by how much they show: the desktop's --border-subtle (#303030) is
  // the firmer of its two, so the phone's names are the other way round.
  borderDefault: '#303030',
  borderSubtle: '#232323',
  borderStrong: '#393939', // --border-strong
  surfaceGroup: '#262626',
  cardBorder: '#262626',
  surfaceGroupPressed: '#303030',
  composerFill: '#232323',
  composerBorder: 'transparent',
  inputFill: '#141414',
  inputBorder: '#393939',
  accentSuccess: '#35d35d', // --accent-success (green-600)
  statusRunning: '#6bb5ff', // --status-running (blue-400)
  accentWarning: '#e89a1c', // --accent-warning (orange-600)
  onWarning: '#141414',
  accentError: '#f44747', // --accent-error
  accentErrorLight: '#ef4444', // --accent-error-light
  accentFocus: '#2792ff', // --accent-focus (blue-500)
  accentNeutral: '#e6e6e6', // --agents-tint-white
  diffAdd: '#35d35d',
  diffAddBg: 'rgba(53, 211, 93, 0.1)',
  diffDel: '#ef4444',
  diffDelBg: 'rgba(244, 71, 71, 0.1)',
  scrim: 'rgba(0, 0, 0, 0.75)', // --color-black-o75
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
  surfaceApp: '#ffffff',
  surfacePanel: '#f5f5f5',
  surfaceControl: '#ebebeb',
  surfaceControlHover: '#e3e3e3',
  surfaceSelected: '#dcdcdc',
  surfaceBubble: '#ededed',
  textStrong: '#0f0f0f',
  textBody: '#1c1c1c',
  textPrimary: '#383838',
  textSecondary: '#5c5c5c',
  // 4.9:1 on a control (placeholders sit there), 5.2 on a panel, 5.7 on the app.
  textMuted: '#666666',
  // Decoration only, as in dark.
  textFaint: '#c2c2c2',
  inkDark: '#0f0f0f',
  inkLight: '#ffffff',
  selectedFill: '#171717',
  onSelectedFill: '#ffffff',
  borderDefault: '#e0e0e0',
  borderSubtle: '#ebebeb',
  borderStrong: '#cfcfcf',
  surfaceGroup: '#ffffff',
  cardBorder: 'transparent',
  surfaceGroupPressed: '#ebebeb',
  composerFill: '#f5f5f5',
  composerBorder: '#e0e0e0',
  inputFill: '#ffffff',
  inputBorder: '#cfcfcf',
  accentSuccess: '#15803d', // green-700
  statusRunning: '#0a63c9', // --status-running (blue-800)
  accentWarning: '#b45309', // amber-700
  onWarning: '#ffffff',
  accentError: '#d42a20',
  accentErrorLight: '#c4261c',
  accentFocus: '#0b6bdc',
  // The neutral accent in light is ink: a white Chief on a white app would be invisible.
  accentNeutral: '#171717',
  diffAdd: '#11672f',
  diffAddBg: 'rgba(21, 128, 61, 0.1)',
  diffDel: '#b0221a',
  diffDelBg: 'rgba(212, 42, 32, 0.08)',
  scrim: 'rgba(0, 0, 0, 0.22)',
  ...media,
};

export const palettes = { dark, light } as const;
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
export const radius = { sm: 4, inner: 10, control: 12, card: 16, sheet: 24, pill: 999 } as const;

/** An avatar's or logo's corner: one squircle proportion at every size. */
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
 * The message field: a chunky capsule of the system's glass (components/Glass.tsx),
 * like the tab bar's. One line is a 48pt pill and the corner stays 24 as it
 * grows, so several lines read as a rounded rectangle rather than a blob.
 * The + is a 48pt glass circle (as tall as one line); send, the mic and Stop
 * are 40pt circles inside the field, 4pt in from its edge. All sit on the
 * last line as the field grows. Every one of them is a 44pt target or more.
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
  height: 48,
  fieldCorner: 24,
  /** Lines before it scrolls inside. */
  maxLines: 6,
  attach: 48,
  send: 40,
  /** Send's inset from the field's edge. */
  inset: 4,
  /**
   * Between the field and the keyboard when it's up. With it down the field
   * sits on the home indicator's inset; up, the sticky view gives that inset
   * back down to this, so the field never touches the keys.
   */
  keyboardGap: 10,
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
 * The dictation waveform (`components/Waveform.tsx`), in the slim row over the
 * field with the time (never inside it: beside the words it squeezed them to
 * a few per line): 2pt bars 2pt apart, a dot at silence and 18pt at full
 * voice, the row's height. Under Reduce Motion a 2pt-thick meter of the same
 * width stands in. Twelve bars, about 0.85 s of voice.
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

/** Agent avatars: in a search group, a chat header, a list row, the agent sheet. */
export const avatarSize = { group: 24, header: 28, list: 48, sheet: 56 } as const;

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

/** The phone's text size in force, as a multiplier. */
export const currentTextScale = () => textScale;

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
 * it frames: titles, pills, avatar initials and buttons.
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

export const lineHeight = (size: number, ratio = 1.4) => Math.round(size * ratio);

export const fonts = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  mono: 'GeistMono_400Regular',
} as const;

/** `color-mix(in srgb, a p%, b)`, which the avatar tile uses. */
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
