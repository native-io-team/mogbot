/**
 * Light or dark, and the palette that goes with it. The system's appearance
 * by default; Settings can hold the phone to one (`Prefs.appearance`).
 *
 * The choice is handed to the platform too (`Appearance.setColorScheme`), so
 * everything native follows it without being told: sheets and their glass,
 * the keyboard, alerts and menus, the tab bar, the status bar. The app only
 * has to draw its own surfaces, which it reads here:
 *
 * - `useColors()` for a colour in render,
 * - `makeStyles((colors) => ({…}))` for a stylesheet: built once per palette,
 *   so switching appearance costs one rebuild, not one per render.
 */

import * as SystemUI from 'expo-system-ui';
import { createContext, useContext, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { Appearance as RNAppearance, StyleSheet, useColorScheme } from 'react-native';
import { useApp, type AppearancePref } from './store';
import {
  atTextScale,
  palettes,
  setTextScale,
  textScaleOf,
  TEXT_SIZES,
  type Appearance,
  type Palette,
} from './theme';

export interface Theme {
  appearance: Appearance;
  colors: Palette;
  /** Settings → Text size as a multiplier (1 at Default). */
  textScale: number;
}

/** What's in force: the phone's own choice, else the system's, else dark (the app's first look). */
export function resolveAppearance(
  pref: AppearancePref | undefined,
  system: string | null | undefined
): Appearance {
  if (pref === 'light' || pref === 'dark') return pref;
  return system === 'light' ? 'light' : 'dark';
}

/**
 * Before React draws anything: the root view takes the system's appearance at
 * once, so a light phone never flashes the dark root (app.config's single
 * `backgroundColor`) under a sheet's corners or the keyboard. The provider
 * corrects it if the phone's own setting says otherwise.
 */
void SystemUI.setBackgroundColorAsync(
  palettes[resolveAppearance(undefined, RNAppearance.getColorScheme())].surfaceApp
).catch(() => {});

/**
 * One theme per appearance and text size, so a change of either is a new
 * context value: every component reading colours or styles re-renders, and
 * `makeStyles` rebuilds its sheet at the new sizes.
 */
const themes = new Map<string, Theme>();
function themeOf(appearance: Appearance, textScale: number): Theme {
  const key = `${appearance}:${textScale}`;
  let theme = themes.get(key);
  if (!theme) {
    theme = { appearance, colors: palettes[appearance], textScale };
    themes.set(key, theme);
  }
  return theme;
}

/** Outside a provider (a test rendering one component) it's dark at Default, as the app was. */
const ThemeContext = createContext<Theme>(themeOf('dark', TEXT_SIZES.default));

export const useTheme = () => useContext(ThemeContext);
export const useColors = () => useContext(ThemeContext).colors;
export const useAppearance = () => useContext(ThemeContext).appearance;
/** The phone's text size in force (Settings → Text size), as a multiplier. */
export const useTextScale = () => useContext(ThemeContext).textScale;

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const pref = useApp((s) => s.prefs.appearance);
  const textSize = useApp((s) => s.prefs.textSize);
  const system = useColorScheme();
  // Set during render, before any child reads `type`: idempotent, and the
  // only writer, so every sheet built under this theme sees the same scale.
  setTextScale(textSize);
  const textScale = textScaleOf(textSize);

  // Before the first paint of a change, so native chrome and our surfaces
  // turn together. 'unspecified' hands it back to the system.
  useLayoutEffect(() => {
    // Optional: react-native-web has no setColorScheme (the web QA build).
    RNAppearance.setColorScheme?.(pref === 'light' || pref === 'dark' ? pref : 'unspecified');
  }, [pref]);

  const theme = themeOf(resolveAppearance(pref, system), textScale);

  // The root view behind everything: what shows through a sheet's corners,
  // above the keyboard as it moves, and during a rotation.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.colors.surfaceApp).catch(() => {});
  }, [theme.colors]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

type Styles = Parameters<typeof StyleSheet.create>[0];

/**
 * A stylesheet that follows the appearance and the text size. Write it as
 * before, with `colors` passed in, and call the hook in each component that
 * uses it. Sizes read from `type` inside the factory are the ones in force.
 */
export function makeStyles<S extends Styles>(factory: (colors: Palette) => S): () => Readonly<S> {
  const built = new Map<Theme, Readonly<S>>();
  return function useStyles() {
    const theme = useTheme();
    const cached = built.get(theme);
    if (cached) return cached;
    const styles = StyleSheet.create(atTextScale(theme.textScale, () => factory(theme.colors)));
    built.set(theme, styles);
    return styles;
  };
}
