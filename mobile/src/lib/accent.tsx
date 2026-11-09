/**
 * The one colour in a black-and-white app. It is an agent's own colour, as in
 * Grok Bot: the Chief of Staff's everywhere (`RootAccent`), and inside an
 * agent's chat, and the sheets opened from it, that agent's (`AgentAccent`).
 * Nothing is picked on the phone: the colour is the agent's, set at the desk
 * (or on the agent sheet), and arrives with the registry like everything else.
 *
 * Only actions and attention take it: the primary button, Send, the cursor,
 * a switch that's on. Outcomes keep their semantic colours (theme.ts), and an
 * approval's answers never take it (`answerAccent`): a red agent's Allow must
 * not read as the dangerous choice.
 *
 * Each agent colour is drawn per appearance (theme.ts `agentTints`): the same
 * hue, deeper in light so it reads on white.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTheme } from './appearance';
import { useApp } from './store';
import {
  agentTints,
  alpha,
  contrast,
  luminance,
  keySide,
  mix,
  palettes,
  type Appearance,
  type Palette,
} from './theme';

export interface Accent {
  /** The fill: a primary button, Send, a switch that's on. */
  accent: string;
  /** The same fill held down. */
  pressed: string;
  /** A tint of it behind something selected. */
  soft: string;
  /** Text and glyphs on the fill: whichever of dark and light ink reads better. */
  onAccent: string;
  /** The keycap's side under the fill: its own shade, toward black (no ink sits on it). */
  side: string;
}

/**
 * The hex an agent colour key draws in this appearance. The one rule for
 * "white" (and for a key this phone doesn't know): it is the neutral accent,
 * the palette's `accentNeutral` — near-white in dark, near-black in light,
 * because a white accent on a white app is no accent at all. Every caller
 * that turns `Agent.color` into a colour goes through here.
 */
export function agentTint(color: string | null | undefined, appearance: Appearance): string {
  return (color && agentTints[appearance][color]) || palettes[appearance].accentNeutral;
}

/** An accent from any hex colour on a palette: its pressed state, a soft tint, and the ink that reads on it. */
export function deriveAccent(hex: string, colors: Palette = palettes.dark): Accent {
  const onAccent =
    contrast(hex, colors.inkDark) >= contrast(hex, colors.inkLight)
      ? colors.inkDark
      : colors.inkLight;
  // Held down, a fill moves toward the surface it sits on: darker in dark,
  // lighter in light. A near-black fill on white would otherwise have nowhere to go.
  return {
    accent: hex,
    pressed: mix(hex, colors.surfaceApp, 0.82),
    soft: alpha(hex, 0.16),
    onAccent,
    side: keySide(hex),
  };
}

/** The accent for an agent's colour key (`Agent.color`) in an appearance. */
export function agentAccent(
  color: string | null | undefined,
  appearance: Appearance = 'dark'
): Accent {
  return deriveAccent(agentTint(color, appearance), palettes[appearance]);
}

/**
 * Allow on every approval, whatever the agent's colour: the neutral accent
 * (near-white with dark ink in dark, near-black with white ink in light).
 * Deny beside it is the outline. The one control that must stay unambiguous
 * is the same in every chat.
 */
export const answerAccent = (appearance: Appearance): Accent => agentAccent('white', appearance);

/** Above this, the system's white thumb all but disappears on an accent track. */
export const LIGHT_ACCENT = 0.6;

/** How far a light accent's on-track is darkened toward the app's surface. */
const LIGHT_TRACK = 0.55;

/**
 * A switch's colours for an accent. On a light accent (white, the Chief's
 * default in dark) a white thumb on a near-white track reads the same as off,
 * so the on-track is a darker shade of it, and the thumb is dark where the
 * platform honours a thumb colour (iOS 26's switch ignores it; Android paints
 * it in both states, so it follows the value). Light mode's accents are all
 * deep, so there the track is the accent itself.
 */
export function switchColors(
  a: Accent,
  on: boolean,
  colors: Palette = palettes.dark
): {
  trackColor: { true: string; false: string };
  thumbColor: string;
  ios_backgroundColor: string;
} {
  const light = luminance(a.accent) > LIGHT_ACCENT;
  return {
    trackColor: {
      true: light ? mix(a.accent, colors.surfaceApp, LIGHT_TRACK) : a.accent,
      false: colors.surfaceSelected,
    },
    thumbColor: on && light ? colors.inkDark : colors.inkLight,
    ios_backgroundColor: colors.surfaceSelected,
  };
}

const AccentContext = createContext<Accent>(agentAccent('white'));

export const useAccent = () => useContext(AccentContext);

/** Allow's colours in the appearance in force. */
export function useAnswerAccent(): Accent {
  const { appearance } = useTheme();
  return useMemo(() => answerAccent(appearance), [appearance]);
}

/** A switch's colours for the accent in scope, in the appearance in force. */
export function useSwitchColors(on: boolean) {
  const accent = useAccent();
  const { colors } = useTheme();
  return switchColors(accent, on, colors);
}

export function AccentProvider({
  color,
  children,
}: {
  color: string | null | undefined;
  children: ReactNode;
}) {
  const { appearance } = useTheme();
  const value = useMemo(() => agentAccent(color, appearance), [color, appearance]);
  return <AccentContext.Provider value={value}>{children}</AccentContext.Provider>;
}

/** The app's accent: the Chief of Staff's colour, the neutral one until the Mac has said. */
export function RootAccent({ children }: { children: ReactNode }) {
  const color = useApp((s) => s.overview?.agents.find((a) => a.isMain)?.color);
  return <AccentProvider color={color}>{children}</AccentProvider>;
}

/** Inside one agent's chat (and its sheets): that agent's colour, the Chief's if it's gone. */
export function AgentAccent({ agentId, children }: { agentId?: string; children: ReactNode }) {
  const root = useAccent();
  const color = useApp((s) =>
    agentId ? s.overview?.agents.find((a) => a.id === agentId)?.color : undefined
  );
  if (!color) return <AccentContext.Provider value={root}>{children}</AccentContext.Provider>;
  return <AccentProvider color={color}>{children}</AccentProvider>;
}
