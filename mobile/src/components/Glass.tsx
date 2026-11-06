/**
 * The system's own glass where there is some: iOS 26's Liquid Glass
 * (expo-glass-effect), the same material as the tab bar, the header's
 * buttons and the native sheets. Everywhere else (iOS before 26, Android,
 * the web QA build, a dev client built before the module was added) it is
 * a plain surface from the theme: `composerFill` with its hairline, or the
 * tint when one is given. So nothing here assumes the glass is there.
 *
 * The glass follows the app's appearance, not only the system's, as the
 * native chrome does (lib/appearance.tsx). Reduce Transparency is the
 * system's to honour: the glass itself turns frosted and opaque under it.
 */

import { requireOptionalNativeModule } from 'expo';
import type { ReactNode } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useAppearance, useColors } from '../lib/appearance';

type GlassModule = typeof import('expo-glass-effect');

/** Loaded only when this build carries the native view: importing it without one throws. */
function loadGlass(): GlassModule | null {
  if (Platform.OS !== 'ios' || !requireOptionalNativeModule('ExpoGlassEffect')) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const glass = require('expo-glass-effect') as GlassModule;
    // Some iOS 26 betas have the components but not the API under them.
    return glass.isLiquidGlassAvailable() && glass.isGlassEffectAPIAvailable() ? glass : null;
  } catch {
    return null;
  }
}

let glass: GlassModule | null | undefined;
const getGlass = () => (glass === undefined ? (glass = loadGlass()) : glass);

/** Whether this phone draws Liquid Glass (iOS 26 and later, in a build with the module). */
export const hasLiquidGlass = () => getGlass() !== null;

export function Glass({
  style,
  tint,
  interactive,
  onLayout,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  /** A tinted glass, for the one prominent action (Send). The plain surface takes it as its fill. */
  tint?: string;
  /** It's a button: the glass answers the touch as the system's own do. */
  interactive?: boolean;
  onLayout?: (e: LayoutChangeEvent) => void;
  children?: ReactNode;
}) {
  const colors = useColors();
  const appearance = useAppearance();
  const g = getGlass();
  if (g) {
    return (
      <g.GlassView
        glassEffectStyle="regular"
        isInteractive={interactive}
        tintColor={tint}
        colorScheme={appearance}
        style={style}
        onLayout={onLayout}
      >
        {children}
      </g.GlassView>
    );
  }
  return (
    <View
      onLayout={onLayout}
      style={[
        style,
        tint
          ? { backgroundColor: tint }
          : {
              backgroundColor: colors.composerFill,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.composerBorder,
            },
      ]}
    >
      {children}
    </View>
  );
}
