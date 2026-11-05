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
import { palettes, type Appearance, type Palette } from './theme';

export interface Theme {
  appearance: Appearance;
  colors: Palette;
}

/** What's in force: the phone's own choice, else the system's, else dark (the app's first look). */
export function resolveAppearance(
  pref: AppearancePref | undefined,
  system: string | null | undefined
): Appearance {
  if (pref === 'light' || pref === 'dark') return pref;
  return system === 'light' ? 'light' : 'dark';
}

const themes: Record<Appearance, Theme> = {
  dark: { appearance: 'dark', colors: palettes.dark },
  light: { appearance: 'light', colors: palettes.light },
};

/** Outside a provider (a test rendering one component) it's dark, as the app was. */
const ThemeContext = createContext<Theme>(themes.dark);

export const useTheme = () => useContext(ThemeContext);
export const useColors = () => useContext(ThemeContext).colors;
export const useAppearance = () => useContext(ThemeContext).appearance;

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const pref = useApp((s) => s.prefs.appearance);
  const system = useColorScheme();

  // Before the first paint of a change, so native chrome and our surfaces
  // turn together. 'unspecified' hands it back to the system.
  useLayoutEffect(() => {
    RNAppearance.setColorScheme(pref === 'light' || pref === 'dark' ? pref : 'unspecified');
  }, [pref]);

  const theme = themes[resolveAppearance(pref, system)];

  // The root view behind everything: what shows through a sheet's corners,
  // above the keyboard as it moves, and during a rotation.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.colors.surfaceApp).catch(() => {});
  }, [theme]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

type Styles = Parameters<typeof StyleSheet.create>[0];

/**
 * A stylesheet that follows the appearance. Write it as before, with
 * `colors` passed in, and call the hook in each component that uses it.
 */
export function makeStyles<S extends Styles>(factory: (colors: Palette) => S): () => Readonly<S> {
  const built = new Map<Palette, Readonly<S>>();
  return function useStyles() {
    const colors = useColors();
    const cached = built.get(colors);
    if (cached) return cached;
    const styles = StyleSheet.create(factory(colors));
    built.set(colors, styles);
    return styles;
  };
}
