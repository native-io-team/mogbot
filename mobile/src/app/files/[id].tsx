/**
 * Everything shared in one conversation, both ways, newest first: the
 * desktop's Files list. All / You / Agent; images as thumbnails, documents
 * open in Quick Look; long-press to share.
 */

import type { SharedFile } from '@shipstudio/companion-protocol';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Spinner } from '../../components/agent';
import { LinkProblem } from '../../components/ConnectionPill';
import { openFile } from '../../components/attachments';
import { choose } from '../../components/menu';
import { Segmented, T } from '../../components/ui';
import { formatAgo } from '../../lib/agents';
import { extensionOf, formatSize, isPreviewableImage, share } from '../../lib/files';
import { attachmentSource, describeError, download, listFiles } from '../../lib/session';
import { useAttachmentSources } from '../../lib/relayImages';
import { useRefresh } from '../../lib/refresh';
import { RefreshStatus } from '../../components/RefreshStatus';
import { useApp } from '../../lib/store';
import { useRemembered } from '../../lib/remembered';
import { withAgentAccent } from '../../lib/accentScreen';
import { iconSize, radius, space, type } from '../../lib/theme';
import { makeStyles, useColors } from '../../lib/appearance';

type Filter = 'all' | 'user' | 'agent';

export default withAgentAccent(Files);

function Files() {
  useAttachmentSources();
  const colors = useColors();
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const agentName = useApp((s) => s.overview?.agents.find((a) => a.id === id)?.name ?? 'Agent');
  const [files, setFiles] = useRemembered<SharedFile[]>(`files:${id}`);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const live = useApp((s) => s.link.kind === 'connected');
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');

  const load = useCallback(() => {
    setLoading(true);
    return listFiles(id)
      .then(
        (f) => {
          setFiles(f);
          setError(null);
        },
        (e: unknown) => setError(describeError(e))
      )
      .finally(() => setLoading(false));
  }, [id, setFiles]);
  const { refreshing, onRefresh, outcome, dismiss } = useRefresh(() => {
    setLoading(true);
    return listFiles(id)
      .then(
        (f) => {
          setFiles(f);
          setError(null);
        },
        (e: unknown) => {
          setError(describeError(e));
          throw e;
        }
      )
      .finally(() => setLoading(false));
  });
  // Asked once the link is up, and again each time it comes back: a cold or
  // deep-linked open lands here before the socket is.
  useEffect(() => {
    if (live) void load();
  }, [load, live]);

  const shown = useMemo(
    () => (files ?? []).filter((f) => filter === 'all' || f.from === filter),
    [files, filter]
  );

  const open = async (f: SharedFile) => {
    if (isPreviewableImage(f.mime)) {
      router.push({
        pathname: '/viewer',
        params: { agentId: id, path: f.path, name: f.name, mime: f.mime },
      });
      return;
    }
    setOpening(f.path);
    try {
      await openFile(id, f);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setOpening(null);
    }
  };

  const shareFile = async (f: SharedFile) => {
    setOpening(f.path);
    try {
      await share(await download({ agentId: id, path: f.path }), f.mime);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setOpening(null);
    }
  };

  return (
    <FlatList
      data={shown}
      keyExtractor={(f) => f.path}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space['2xl'] }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.textSecondary}
          onRefresh={onRefresh}
        />
      }
      ListHeaderComponent={
        <View style={styles.head}>
          <RefreshStatus outcome={outcome} onRetry={onRefresh} onDismiss={dismiss} />
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'user', label: 'You' },
              { value: 'agent', label: agentName },
            ]}
          />
          {error && live && (
            <T variant="small" color={colors.accentErrorLight}>
              {error}
            </T>
          )}
        </View>
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          {files == null ? (
            !live ? (
              <LinkProblem what="Files from this conversation" macName={macName} />
            ) : loading && !refreshing ? (
              <Spinner />
            ) : null
          ) : (
            <T color={colors.textSecondary}>
              {filter === 'user'
                ? `You haven’t sent ${agentName} any files.`
                : filter === 'agent'
                  ? `${agentName} hasn’t shared any files.`
                  : 'No files in this conversation yet.'}
            </T>
          )}
        </View>
      }
      renderItem={({ item, index }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.name}, ${formatSize(item.size)}`}
          onPress={() => void open(item)}
          onLongPress={() =>
            choose(item.name, [
              { label: 'Open', run: () => void open(item) },
              { label: 'Share…', run: () => void shareFile(item) },
            ])
          }
          style={({ pressed }) => [
            styles.row,
            index > 0 && styles.divider,
            pressed && { backgroundColor: colors.surfaceControl },
          ]}
        >
          <View style={styles.thumb}>
            {isPreviewableImage(item.mime) ? (
              <Image
                source={attachmentSource(id, item.path, 48)}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={150}
              />
            ) : opening === item.path ? (
              <Spinner size={iconSize.body} />
            ) : (
              <T variant="caption" color={colors.textSecondary} style={styles.ext}>
                {extensionOf(item.name)}
              </T>
            )}
          </View>
          <View style={{ flex: 1, gap: space['2xs'] }}>
            <T color={colors.textStrong} numberOfLines={1}>
              {item.name}
            </T>
            <T variant="caption" color={colors.textMuted}>
              {item.from === 'user' ? 'You' : agentName} · {formatSize(item.size)} ·{' '}
              {formatAgo(item.ts)}
            </T>
          </View>
        </Pressable>
      )}
    />
  );
}

const useStyles = makeStyles((colors) => ({
  head: { padding: space.lg, gap: space.md },
  empty: { padding: space.xl, alignItems: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDefault },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: radius.inner,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
  ext: { fontSize: type.micro, letterSpacing: 0.4 },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../../components/ScreenError';
