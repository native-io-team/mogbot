/**
 * Dynamic Type for the web QA build (`pnpm qa:web --font-scale 3.1`), which
 * has none: react-native-web reports a font scale of 1 and ignores
 * `maxFontSizeMultiplier`. With `window.__QA_FONT_SCALE` set before the app
 * loads, `useWindowDimensions().fontScale` reports it (so the layouts that
 * stack at large sizes stack) and `T` sets its size as iOS would, at the
 * scale or its own clamp, whichever is less. Plain `Text` and inputs are not
 * scaled, so a shot is a close stand-in, not the device. Native: always 0,
 * nothing patched.
 */

import { Dimensions, Platform } from 'react-native';

export const QA_FONT_SCALE: number =
  Platform.OS === 'web'
    ? Number((globalThis as { __QA_FONT_SCALE?: unknown }).__QA_FONT_SCALE) || 0
    : 0;

if (QA_FONT_SCALE) {
  const get = Dimensions.get.bind(Dimensions);
  Dimensions.get = ((dim: 'window' | 'screen') => ({
    ...get(dim),
    fontScale: QA_FONT_SCALE,
  })) as typeof Dimensions.get;
}

/** A text style's size and line at the stand-in scale, clamped at `max` as iOS clamps. */
export function qaScaled(
  style: { fontSize?: number; lineHeight?: number } | null | undefined,
  max: number | undefined
): { fontSize?: number; lineHeight?: number } | null {
  if (!QA_FONT_SCALE || !style?.fontSize) return null;
  const k = Math.max(1, max && max >= 1 ? Math.min(QA_FONT_SCALE, max) : QA_FONT_SCALE);
  return {
    fontSize: Math.round(style.fontSize * k),
    ...(style.lineHeight ? { lineHeight: Math.round(style.lineHeight * k) } : {}),
  };
}
