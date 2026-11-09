/**
 * A long-press menu, and every other list of choices (`choose`). iOS gets the
 * system action sheet; Android gets a Material bottom sheet with icons and
 * ripples: an Alert there holds three buttons at most and silently drops the
 * rest, which on an approval's ⋯ would hide an answer. Rows on iOS use the
 * native context menu instead (see the Agents list); this is for everything
 * that isn't a link.
 */

import { useSyncExternalStore } from 'react';
import { ActionSheetIOS, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Action } from '../lib/actions';
import { iconSize, radius, space, PRESSED } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
import { Icon, useRipple, T } from './ui';

type Item = Omit<Action<string>, 'icon'> & { icon?: Action<string>['icon'] };

interface Open {
  title?: string;
  message?: string;
  actions: Item[];
  run: (id: string) => void;
  /** A "Cancel" row at the end, as the iOS sheet has. */
  cancel?: boolean;
}

let open: Open | null = null;
const listeners = new Set<() => void>();
const set = (next: Open | null) => {
  open = next;
  listeners.forEach((l) => l());
};

export function showActions<Id extends string>(
  title: string | undefined,
  actions: Action<Id>[],
  run: (id: Id) => void
) {
  if (!actions.length) return;
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...actions.map((a) => a.title), 'Cancel'],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.flatMap((a, i) => (a.destructive ? [i] : [])),
      },
      (i) => {
        const a = actions[i];
        if (a) run(a.id);
      }
    );
    return;
  }
  set({ title, actions, run: run as (id: string) => void });
}

export interface Choice {
  label: string;
  destructive?: boolean;
  run: () => void;
}

/** The system's action sheet on iOS, the app's sheet on Android; every choice shown. Cancel is added. */
export function choose(title: string | undefined, choices: Choice[], message?: string) {
  if (!choices.length) return;
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        message,
        options: [...choices.map((c) => c.label), 'Cancel'],
        cancelButtonIndex: choices.length,
        destructiveButtonIndex: choices.flatMap((c, i) => (c.destructive ? [i] : [])),
      },
      (i) => choices[i]?.run()
    );
    return;
  }
  set({
    title,
    message,
    cancel: true,
    actions: choices.map((c, i) => ({ id: String(i), title: c.label, destructive: c.destructive })),
    run: (id) => choices[Number(id)]?.run(),
  });
}

/** Mounted once at the root; draws the Android sheet when one is open. */
export function MenuHost() {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const insets = useSafeAreaInsets();
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open
  );
  if (Platform.OS === 'ios') return null;
  return (
    <Modal transparent visible={!!current} onRequestClose={() => set(null)} animationType="none">
      {current && (
        <View style={StyleSheet.absoluteFill}>
          <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(150)}>
            <Pressable
              style={[StyleSheet.absoluteFill, styles.scrim]}
              onPress={() => set(null)}
              accessibilityRole="button"
              accessibilityLabel="Close menu"
            />
          </Animated.View>
          <Animated.View
            entering={SlideInDown.duration(220)}
            exiting={SlideOutDown.duration(160)}
            style={[styles.sheet, { paddingBottom: insets.bottom + space.sm }]}
          >
            {!!current.title && (
              <T
                variant="small"
                color={colors.textSecondary}
                style={styles.title}
                numberOfLines={2}
              >
                {current.title}
              </T>
            )}
            {!!current.message && (
              <T variant="caption" color={colors.textSecondary} style={styles.message}>
                {current.message}
              </T>
            )}
            {current.actions.map((a) => (
              <Pressable
                key={a.id}
                accessibilityRole="menuitem"
                android_ripple={ripple}
                onPress={() => {
                  set(null);
                  current.run(a.id);
                }}
                style={({ pressed }) => [styles.item, pressed && Platform.OS === 'ios' && PRESSED]}
              >
                {a.icon && (
                  <Icon
                    name={a.icon}
                    size={iconSize.button}
                    color={a.destructive ? colors.accentErrorLight : colors.textSecondary}
                  />
                )}
                <T
                  color={a.destructive ? colors.accentErrorLight : colors.textBody}
                  style={{ flexShrink: 1 }}
                >
                  {a.title}
                </T>
              </Pressable>
            ))}
            {current.cancel && (
              <Pressable
                accessibilityRole="menuitem"
                android_ripple={ripple}
                onPress={() => set(null)}
                style={({ pressed }) => [styles.item, pressed && Platform.OS === 'ios' && PRESSED]}
              >
                <T color={colors.textSecondary}>Cancel</T>
              </Pressable>
            )}
          </Animated.View>
        </View>
      )}
    </Modal>
  );
}

const useStyles = makeStyles((colors) => ({
  scrim: { backgroundColor: colors.scrim },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surfacePanel,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingTop: space.sm,
  },
  title: { paddingHorizontal: space.xl, paddingTop: space.md, paddingBottom: space.sm },
  message: { paddingHorizontal: space.xl, paddingBottom: space.md },
  item: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingHorizontal: space.xl,
  },
}));
