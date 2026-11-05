/**
 * The one colour in a black-and-white app. It is an agent's own colour, as in
 * Grok Bot: the Chief of Staff's everywhere (`RootAccent`), and inside an
 * agent's chat, and the sheets opened from it, that agent's (`AgentAccent`).
 * Nothing is picked on the phone: the colour is the agent's, set at the desk
 * (or on the agent sheet), and arrives with the registry like everything else.
 *
 * Only actions and attention take it: the primary button, Send, the cursor,
 * a switch that's on. Outcomes keep their semantic colours (theme.ts), and an
 * approval's answers never take it (`ANSWER`): a red agent's Allow must not
 * read as the dangerous choice.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useApp } from './store';
import { agentTints, alpha, colors, contrast, luminance, mix } from './theme';

export interface Accent {
  /** The fill: a primary button, Send, a switch that's on. */
  accent: string;
  /** The same fill held down. */
  pressed: string;
  /** A tint of it behind something selected. */
  soft: string;
  /** Text and glyphs on the fill: whichever of dark and light ink reads better. */
  onAccent: string;
}

/** An accent from any hex colour: its pressed state, a soft tint, and the ink that reads on it. */
export function deriveAccent(hex: string): Accent {
  const onAccent =
    contrast(hex, colors.inkDark) >= contrast(hex, colors.inkLight)
      ? colors.inkDark
      : colors.inkLight;
  return {
    accent: hex,
    pressed: mix(hex, colors.surfaceApp, 0.82),
    soft: alpha(hex, 0.16),
    onAccent,
  };
}

/** The accent for an agent's colour key (`Agent.color`); white for one this phone doesn't know. */
export function agentAccent(color: string | null | undefined): Accent {
  return deriveAccent((color && agentTints[color]) || colors.textWhite);
}

/**
 * Allow on every approval, whatever the agent's colour: near-white with dark
 * ink. Deny beside it is the outline. The one control that must stay
 * unambiguous is the same in every chat.
 */
export const ANSWER: Accent = agentAccent('white');

/** Above this, the system's white thumb all but disappears on an accent track. */
export const LIGHT_ACCENT = 0.6;

/**
 * A switch's colours for an accent. On a light accent (white, the Chief's
 * default) a white thumb on a near-white track reads the same as off, so the
 * thumb goes dark when on. Otherwise the thumb is white, on a dark track when off.
 * (Android paints `thumbColor` in both states, so it follows the value.)
 */
export function switchColors(
  a: Accent,
  on: boolean
): {
  trackColor: { true: string; false: string };
  thumbColor: string;
  ios_backgroundColor: string;
} {
  const light = luminance(a.accent) > LIGHT_ACCENT;
  return {
    trackColor: { true: a.accent, false: colors.surfaceSelected },
    thumbColor: on && light ? colors.inkDark : colors.textWhite,
    ios_backgroundColor: colors.surfaceSelected,
  };
}

const DEFAULT = agentAccent('white');
const AccentContext = createContext<Accent>(DEFAULT);

export const useAccent = () => useContext(AccentContext);

export function AccentProvider({
  color,
  children,
}: {
  color: string | null | undefined;
  children: ReactNode;
}) {
  const value = useMemo(() => agentAccent(color), [color]);
  return <AccentContext.Provider value={value}>{children}</AccentContext.Provider>;
}

/** The app's accent: the Chief of Staff's colour, white until the Mac has said. */
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
