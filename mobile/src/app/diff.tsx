/**
 * A change card, opened: each file it touched, and that turn's diff of the
 * one you tap (`agents.changeDiff`, the desktop's diff modal). The project
 * and snapshots come from the stored card on the Mac, never from here.
 */

import type { FileDiff } from '@shipstudio/companion-protocol';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Spinner } from '../components/agent';
import { DiffLines } from '../components/diff';
import { Icon, T, SheetPage, InsetDivider, groupSurface } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { folderName } from '../lib/agents';
import { changeDiff, describeError } from '../lib/session';
import { useApp } from '../lib/store';
import { iconSize, space } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';

type Loaded = { diff: FileDiff } | { error: string } | 'loading';

const STATUS = { added: 'New', modified: 'Changed', deleted: 'Deleted' } as const;

export default function Diff() {
  const colors = useColors();
  const styles = useStyles();
  const { agentId, messageId } = useLocalSearchParams<{ agentId: string; messageId: string }>();
  const changes = useApp(
    (s) => s.chats[agentId]?.messages.find((m) => m.id === messageId)?.changes
  );
  const connected = useApp((s) => s.link.kind === 'connected');
  const [open, setOpen] = useState<Record<string, Loaded>>({});

  if (!changes) {
    return (
      <T color={colors.textSecondary} style={styles.note}>
        This change isn’t in the saved chat any more.
      </T>
    );
  }

  const toggle = (path: string) => {
    if (open[path]) {
      const rest = { ...open };
      delete rest[path];
      return setOpen(rest);
    }
    setOpen((o) => ({ ...o, [path]: 'loading' }));
    changeDiff(agentId, messageId, path).then(
      (diff) => setOpen((o) => ({ ...o, [path]: { diff } })),
      (e: unknown) => setOpen((o) => ({ ...o, [path]: { error: describeError(e) } }))
    );
  };

  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={{ gap: space['2xs'] }}>
          <SheetTitle>
            {changes.fileCount} file{changes.fileCount === 1 ? '' : 's'} changed
          </SheetTitle>
          <T variant="small" color={colors.textSecondary}>
            {/* The project, never the branch: no branch names in what a person reads. */}
            {folderName(changes.project)}
            {' · '}
            <T variant="small" color={colors.diffAdd} style={styles.count}>
              +{changes.added}
            </T>{' '}
            <T variant="small" color={colors.diffDel} style={styles.count}>
              −{changes.removed}
            </T>
          </T>
        </View>
        <View style={styles.group}>
          {changes.files.map((f, i) => {
            const state = open[f.path];
            return (
              <View key={f.path}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !!state, disabled: !connected && !state }}
                  disabled={!connected && !state}
                  onPress={() => toggle(f.path)}
                  style={({ pressed }) => [styles.fileHead, pressed && { opacity: 0.6 }]}
                >
                  <Icon
                    name={state ? 'chevron.down' : 'chevron.right'}
                    size={iconSize.inline}
                    color={colors.textMuted}
                  />
                  <T
                    variant="small"
                    color={colors.textStrong}
                    numberOfLines={1}
                    style={{ flex: 1 }}
                  >
                    {f.path}
                  </T>
                  <T variant="caption" color={colors.textMuted} style={styles.count}>
                    {STATUS[f.status]}
                    {f.added != null && (
                      <T variant="caption" color={colors.diffAdd}>{` +${f.added}`}</T>
                    )}
                    {f.removed != null && (
                      <T variant="caption" color={colors.diffDel}>{` −${f.removed}`}</T>
                    )}
                  </T>
                </Pressable>
                {state === 'loading' ? (
                  <View style={styles.pad}>
                    <Spinner size={iconSize.body} />
                  </View>
                ) : state && 'error' in state ? (
                  <T variant="small" color={colors.accentErrorLight} style={styles.pad}>
                    {state.error}
                  </T>
                ) : state ? (
                  <Animated.View entering={FadeIn.duration(180)} style={styles.pad}>
                    {state.diff.isBinary ? (
                      <T variant="small" color={colors.textSecondary}>
                        A binary file: there’s no text to compare.
                      </T>
                    ) : (
                      <DiffLines
                        lines={state.diff.content.replace(/\n$/, '').split('\n')}
                        label={`Diff of ${f.path}`}
                      />
                    )}
                  </Animated.View>
                ) : null}
                {i < changes.files.length - 1 && <InsetDivider />}
              </View>
            );
          })}
        </View>
        {!connected && (
          <T variant="small" color={colors.textSecondary}>
            Opening a file’s diff needs your Mac.
          </T>
        )}
      </ScrollView>
    </SheetPage>
  );
}

const useStyles = makeStyles((colors) => ({
  content: { padding: space.lg, paddingTop: space.xl, gap: space.md, paddingBottom: space['2xl'] },
  note: { padding: space.xl, textAlign: 'center' },
  group: groupSurface(colors),
  count: { fontVariant: ['tabular-nums'] },
  fileHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 44,
  },
  pad: { paddingHorizontal: space.md, paddingBottom: space.md },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
