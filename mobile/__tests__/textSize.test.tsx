/**
 * Settings → Text size: the type scale follows the phone's choice app-wide
 * (every `makeStyles` sheet and `T` rebuilt at the new sizes), on top of
 * Dynamic Type, saved on the phone and read back safely.
 */

import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text, type TextStyle } from 'react-native';
import { AppearanceProvider, makeStyles } from '../src/lib/appearance';
import { readPrefs } from '../src/lib/prefs';
import { defaultPrefs, getApp, setApp } from '../src/lib/store';
import {
  atTextScale,
  baseType,
  READ_MAX_SCALE,
  scaledSize,
  setTextScale,
  TEXT_SIZES,
  type,
} from '../src/lib/theme';
import { T } from '../src/components/ui';

const useStyles = makeStyles((colors) => ({
  reply: { fontSize: type.read, color: colors.textBody },
}));

function Probe() {
  const styles = useStyles();
  return (
    <>
      <Text testID="sheet" style={styles.reply}>
        sheet
      </Text>
      <T testID="t" variant="body">
        t
      </T>
    </>
  );
}

const sizeOf = (id: string): number | undefined =>
  StyleSheet.flatten(screen.getByTestId(id).props.style as TextStyle)?.fontSize;

afterEach(() => {
  setApp({ prefs: defaultPrefs });
  setTextScale('default');
});

describe('the type scale', () => {
  it('is the base scale at Default', () => {
    setTextScale('default');
    expect(type.body).toBe(16);
    expect(type.read).toBe(17);
    expect(type.caption).toBe(12);
  });

  it('scales every size, on whole points, at each step', () => {
    for (const [key, k] of Object.entries(TEXT_SIZES)) {
      setTextScale(key);
      for (const role of Object.keys(baseType) as (keyof typeof baseType)[]) {
        expect(type[role]).toBe(Math.round(baseType[role] * k));
      }
    }
  });

  it('goes the right way and stays readable at the ends', () => {
    expect(scaledSize(baseType.read, TEXT_SIZES.smaller)).toBe(15);
    expect(scaledSize(baseType.read, TEXT_SIZES.largest)).toBe(21);
    // The smallest caption is still at least 10pt.
    expect(scaledSize(baseType.caption, TEXT_SIZES.smaller)).toBeGreaterThanOrEqual(10);
  });

  it('builds a sheet at a given scale and puts the one in force back', () => {
    setTextScale('larger');
    expect(atTextScale(1, () => type.body)).toBe(16);
    expect(type.body).toBe(18);
  });

  it('treats an unknown step as Default', () => {
    setTextScale('huge');
    expect(type.body).toBe(16);
  });
});

describe('the setting, app-wide', () => {
  it('rebuilds stylesheets and the text primitive when it changes', async () => {
    await render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>
    );
    expect(sizeOf('sheet')).toBe(17);
    expect(sizeOf('t')).toBe(16);

    await act(() => {
      setApp({ prefs: { ...getApp().prefs, textSize: 'largest' } });
    });
    expect(sizeOf('sheet')).toBe(21);
    expect(sizeOf('t')).toBe(20);

    await act(() => {
      setApp({ prefs: { ...getApp().prefs, textSize: 'smaller' } });
    });
    expect(sizeOf('sheet')).toBe(15);
    expect(sizeOf('t')).toBe(14);
  });

  it('lets Dynamic Type scale words on top, clamped at the reading limit', async () => {
    await render(<T testID="t">words</T>);
    const t = screen.getByTestId('t');
    expect(t.props.allowFontScaling).not.toBe(false);
    expect(t.props.maxFontSizeMultiplier).toBe(READ_MAX_SCALE);
  });

  it('keeps chrome’s own, lower clamp where it passes one', async () => {
    await render(
      <T testID="t" maxFontSizeMultiplier={1.3}>
        chrome
      </T>
    );
    expect(screen.getByTestId('t').props.maxFontSizeMultiplier).toBe(1.3);
  });
});

describe('saved on the phone', () => {
  it('defaults to Default', () => {
    expect(defaultPrefs.textSize).toBe('default');
    expect(readPrefs({}).textSize).toBe('default');
  });

  it('reads back what was chosen', () => {
    expect(readPrefs({ textSize: 'larger' }).textSize).toBe('larger');
  });

  it('falls back to Default for a value this build doesn’t know', () => {
    expect(readPrefs({ textSize: 'gigantic' as never }).textSize).toBe('default');
  });

  it('keeps the other settings it was saved with', () => {
    expect(readPrefs({ appearance: 'light', haptics: false })).toEqual({
      ...defaultPrefs,
      appearance: 'light',
      haptics: false,
    });
  });
});
