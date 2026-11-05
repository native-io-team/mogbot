/**
 * Web QA stand-in for expo-symbols (see metro.config.js): the Material
 * Symbol the app's own `MATERIAL` map names, drawn from Google's font, so the
 * icons are the Android set rather than SF Symbols.
 */
import { Text } from 'react-native';
import { MATERIAL, type SFName } from '../../src/lib/icons';

const FONT = 'Material Symbols Outlined';
let loaded = false;
function loadFont() {
  if (loaded || typeof document === 'undefined') return;
  loaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href =
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block';
  document.head.appendChild(link);
}

export function SymbolView({
  name,
  size = 24,
  tintColor,
}: {
  name: string | { ios?: string; android?: string; web?: string };
  size?: number;
  tintColor?: string;
}) {
  loadFont();
  const glyph =
    typeof name === 'string' ? MATERIAL[name as SFName] : (name.web ?? name.android ?? name.ios);
  if (!glyph) return null;
  return (
    <Text
      accessible={false}
      style={{
        fontFamily: FONT,
        fontSize: size,
        lineHeight: size,
        width: size,
        height: size,
        color: tintColor,
        textAlign: 'center',
        overflow: 'hidden',
        // A glyph never gives up width in a row that wraps (rn-web Text
        // shrinks, and a squeezed ligature shows its name's first letter).
        flexShrink: 0,
        whiteSpace: 'nowrap',
      } as object}
    >
      {glyph}
    </Text>
  );
}
