/**
 * Projects on the Mac and their session tabs, each with its state as
 * Remote Access reads it: anything waiting on a decision first. The Mac
 * sends each change as it happens (`projects.changed`); pull to re-read.
 * Tap a tab to watch it, answer it, or type to it; start a new one; or
 * photograph the project's live preview.
 *
 * The phone is for the chat, so this is the plain-language view of what's
 * running: no branch names or git counts up front, just how many files
 * have changed, and each tab as its engine names it.
 */

import type { ProjectSummary, SessionSummary } from '@shipstudio/companion-protocol';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { Spinner } from '../../../components/agent';
import { ConnectionNotice, LinkProblem, useNow } from '../../../components/ConnectionPill';
import { SessionState, useTaskName } from '../../../components/session';
import { choose } from '../../../components/menu';
import { Button, Icon, useRipple, T } from '../../../components/ui';
import { formatAgo } from '../../../lib/agents';
import { haptic } from '../../../lib/haptics';
import { canCall, describeError, previewScreenshot, refreshProjects } from '../../../lib/session';
import { useApp } from '../../../lib/store';
import { fonts, iconSize, radius, space } from '../../../lib/theme';
import { makeStyles, useColors } from '../../../lib/appearance';

/** Waiting on you first, then the most recently active. */
function order(projects: ProjectSummary[]): ProjectSummary[] {
  const asking = (p: ProjectSummary) => p.sessions.some((s) => s.state === 'needs_decision');
  const last = (p: ProjectSummary) => Math.max(0, ...p.sessions.map((s) => s.lastOutputAt));
  return [...projects].sort(
    (a, b) =>
      Number(asking(b)) - Number(asking(a)) || last(b) - last(a) || a.name.localeCompare(b.name)
  );
}

export default function Projects() {
  const colors = useColors();
  const styles = useStyles();
  const projects = useApp((s) => s.projects);
  const live = useApp((s) => s.link.kind === 'connected');
  const served = useApp((s) => canCall('projects.list', s.welcome));
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    () =>
      refreshProjects().then(
        () => setError(null),
        (e: unknown) => setError(describeError(e))
      ),
    []
  );
  const sorted = useMemo(() => order(projects ?? []), [projects]);

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Projects',
          headerLargeTitle: true,
          headerLargeTitleShadowVisible: false,
          headerLargeStyle: { backgroundColor: colors.surfaceApp },
          headerLargeTitleStyle: { fontFamily: fonts.semibold, color: colors.textStrong },
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.textSecondary}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        <ConnectionNotice />
        {/* The link first: a Mac that's away isn't one that needs updating. */}
        {!live ? (
          projects == null ? (
            <View style={styles.problem}>
              <LinkProblem what="Your projects" macName={macName} />
            </View>
          ) : (
            <>
              <AsOf />
              {sorted.length === 0 ? (
                <T color={colors.textSecondary} style={styles.note}>
                  No projects on {macName} when it was last seen.
                </T>
              ) : (
                sorted.map((p) => <ProjectCard key={p.path} project={p} onError={setError} />)
              )}
            </>
          )
        ) : !served ? (
          <T color={colors.textSecondary} style={styles.note}>
            Update the app on {macName} to see its projects here.
          </T>
        ) : projects == null ? (
          <View style={styles.note}>
            <Spinner />
          </View>
        ) : sorted.length === 0 ? (
          <T color={colors.textSecondary} style={styles.note}>
            No projects on {macName} yet.
          </T>
        ) : (
          sorted.map((p) => <ProjectCard key={p.path} project={p} onError={setError} />)
        )}
        {error && live && (
          <T variant="small" color={colors.accentErrorLight} style={styles.note}>
            {error}
          </T>
        )}
      </ScrollView>
    </>
  );
}

/** "PROJECTS · AS OF 4 MIN AGO": the saved copy, said the way the agents list says it. */
function AsOf() {
  const colors = useColors();
  const styles = useStyles();
  useNow(30_000);
  const asOf = useApp((s) => (s.link.kind === 'reconnecting' ? s.link.lastSeenAt : s.syncedAt));
  if (!asOf) return null;
  return (
    <T variant="caption" color={colors.textMuted} style={styles.asOf} accessibilityRole="header">
      {`Projects · as of ${formatAgo(asOf)}`.toUpperCase()}
    </T>
  );
}

function ProjectCard({
  project,
  onError,
}: {
  project: ProjectSummary;
  onError: (text: string | null) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const live = useApp((s) => s.link.kind === 'connected');
  const canStart = useApp((s) => canCall('sessions.start', s.welcome));
  const canShoot = useApp((s) => canCall('preview.screenshot', s.welcome));
  const [shooting, setShooting] = useState(false);

  const shoot = () =>
    choose('Screenshot the preview', [
      { label: 'Desktop', run: () => void take('desktop') },
      { label: 'Phone', run: () => void take('phone') },
    ]);
  const take = async (device: 'desktop' | 'phone') => {
    setShooting(true);
    onError(null);
    try {
      const shot = await previewScreenshot(project.path, device);
      haptic.success();
      router.push({
        pathname: '/viewer',
        params: { uri: shot.uri, name: `${project.name} · ${device}`, mime: shot.mime },
      });
    } catch (e) {
      haptic.error();
      onError(describeError(e));
    } finally {
      setShooting(false);
    }
  };

  // What's changed, in words: not the branch, and not git's "uncommitted".
  const meta = project.dirtyFiles
    ? `${project.dirtyFiles} file${project.dirtyFiles === 1 ? '' : 's'} changed`
    : null;
  return (
    <Animated.View layout={LinearTransition.springify().damping(20)} style={styles.card}>
      <View style={styles.cardHead}>
        <Icon name="folder.fill" size={iconSize.body} color={colors.textMuted} />
        <T variant="headline" color={colors.textStrong} numberOfLines={1} style={{ flexShrink: 1 }}>
          {project.name}
        </T>
        <View style={{ flex: 1 }} />
        {!!meta && (
          <T variant="caption" color={colors.textMuted} numberOfLines={1} style={styles.meta}>
            {meta}
          </T>
        )}
      </View>
      {project.sessions.length === 0 ? (
        <T variant="small" color={colors.textSecondary} style={styles.empty}>
          Nothing running here
        </T>
      ) : (
        project.sessions.map((s, i) => (
          <SessionRow key={s.sessionId} session={s} project={project} first={i === 0} />
        ))
      )}
      {(canStart || canShoot) && (
        <View style={styles.tools}>
          {canStart && (
            <Button
              title="New task"
              icon="plus"
              size="compact"
              variant="ghost"
              disabled={!live}
              onPress={() =>
                router.push({
                  pathname: '/start',
                  params: { project: project.path, name: project.name },
                })
              }
            />
          )}
          {canShoot && (
            <Button
              title={shooting ? 'Taking screenshot…' : 'Screenshot'}
              icon="camera"
              size="compact"
              variant="ghost"
              busy={shooting}
              disabled={!live}
              onPress={shoot}
            />
          )}
        </View>
      )}
    </Animated.View>
  );
}

function SessionRow({
  session,
  project,
  first,
}: {
  session: SessionSummary;
  project: ProjectSummary;
  first: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const router = useRouter();
  const now = useNow(15_000);
  const name = useTaskName(session.sessionId);
  return (
    <Animated.View entering={FadeIn.duration(200)}>
      <Pressable
        accessibilityRole="button"
        android_ripple={ripple}
        onPress={() =>
          router.push({
            pathname: '/session/[id]',
            params: {
              id: session.sessionId,
              project: project.name,
              path: project.path,
              tab: name,
            },
          })
        }
        style={({ pressed }) => [
          styles.session,
          !first && styles.divider,
          pressed && { backgroundColor: colors.surfaceControl },
        ]}
      >
        <View style={styles.sessionText}>
          <View style={styles.sessionTop}>
            <T variant="subhead" color={colors.textStrong} numberOfLines={1} style={{ flex: 1 }}>
              {name}
            </T>
            <T variant="caption" color={colors.textMuted}>
              {formatAgo(session.lastOutputAt, now)}
            </T>
          </View>
          <SessionState session={session} />
        </View>
        <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
      </Pressable>
    </Animated.View>
  );
}

const useStyles = makeStyles((colors) => ({
  content: { paddingBottom: space['2xl'], gap: space.md },
  note: { paddingHorizontal: space.lg, paddingVertical: space.md },
  problem: { alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.xl },
  asOf: { paddingHorizontal: space.lg, paddingTop: space.sm },
  card: {
    marginHorizontal: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    overflow: 'hidden',
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  meta: { maxWidth: '55%' },
  empty: { paddingHorizontal: space.lg, paddingBottom: space.md },
  session: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDefault },
  sessionText: { flex: 1, gap: space['2xs'] },
  sessionTop: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  tools: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    // With the ghost button's own 12, its glyph lines up with the text above.
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
  },
}));
