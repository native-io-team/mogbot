/**
 * A change card, opened as a review: what the agent said it did and every
 * file it touched (Overview), then each file's diff one after another
 * (Files), its name held at the top while you read it. Tick a file
 * Reviewed and it folds away; "3 of 5 reviewed" says where you are. A long
 * press on a line asks the agent about it (the line goes into the chat's
 * message as a quote). Keep / Discard sit at the foot while the copy is open.
 *
 * Diffs come from the Mac one file at a time (`agents.changeDiff`), never
 * from here; the project comes from the stored card.
 */

import type { AgentMessage, ChangedFile, FileDiff } from '@shipstudio/companion-protocol';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, type ScrollViewInstance, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../components/agent';
import { useCopyParts } from '../components/copy';
import { showActions } from '../components/menu';
import { ReviewDiff } from '../components/reviewDiff';
import { SheetTitle } from '../components/SheetTitle';
import { Icon, InsetDivider, Segmented, SheetPage, T, groupSurface } from '../components/ui';
import { plainText } from '../lib/actions';
import { folderName } from '../lib/agents';
import { makeStyles, useColors } from '../lib/appearance';
import { lineQuote, reviewOrder, splitPath, type DiffRow } from '@shipstudio/companion-protocol';
import { setComposer } from '../lib/drafts';
import { haptic } from '../lib/haptics';
import { loadReviewed, setReviewed, useReviewed } from '../lib/reviewed';
import { changeDiff, describeError } from '../lib/session';
import { getApp, useApp } from '../lib/store';
import { iconSize, radius, space } from '../lib/theme';
import { useComputer } from '../lib/computer';

type Loaded = { diff: FileDiff } | { error: string } | 'loading';
type Tab = 'overview' | 'files';

const STATUS = { added: 'New', modified: 'Changed', deleted: 'Deleted' } as const;
/** Diffs asked of the Mac at once. */
const AT_ONCE = 3;
/** What the agent said, before "Show all". */
const SAID_MAX = 700;

/**
 * What the agent said about this change: its reply in the same turn, the
 * last agent line before the card in the same conversation. None when there
 * isn't one (the card stands alone).
 */
export function saidBefore(messages: AgentMessage[], cardId: string): string | null {
  const at = messages.findIndex((m) => m.id === cardId);
  if (at < 0) return null;
  const conversation = messages[at].conversation;
  for (let i = at - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.conversation !== conversation) continue;
    if (m.kind === 'user') return null;
    if (m.kind === 'agent' && m.text.trim()) return plainText(m.text).trim();
  }
  return null;
}

export default function Diff() {
  const comp = useComputer();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { agentId, messageId } = useLocalSearchParams<{ agentId: string; messageId: string }>();
  const messages = useApp((s) => s.chats[agentId]?.messages);
  const message = messages?.find((m) => m.id === messageId);
  const changes = message?.changes;
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === agentId));
  const connected = useApp((s) => s.link.kind === 'connected');
  const reviewed = useReviewed(agentId, messageId);
  const [tab, setTab] = useState<Tab>('overview');
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [saidOpen, setSaidOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const offsets = useRef<Record<string, number>>({});
  const pendingJump = useRef<string | null>(null);

  useEffect(() => {
    void loadReviewed();
  }, []);

  const said = useMemo(
    () => (messages && message ? saidBefore(messages, message.id) : null),
    [messages, message]
  );

  // Every file's diff, a few at a time, once Files opens.
  const files = changes?.files;
  useEffect(() => {
    if (tab !== 'files' || !files || !connected) return;
    let live = true;
    const queue = files.filter((f) => !loaded[f.path]).map((f) => f.path);
    if (!queue.length) return;
    setLoaded((o) => {
      const next: Record<string, Loaded> = { ...o };
      for (const p of queue) next[p] = 'loading';
      return next;
    });
    const next = async (): Promise<void> => {
      const path = queue.shift();
      if (!path || !live) return;
      try {
        const diff = await changeDiff(agentId, messageId, path);
        if (live) setLoaded((o) => ({ ...o, [path]: { diff } }));
      } catch (e: unknown) {
        if (live) setLoaded((o) => ({ ...o, [path]: { error: describeError(e) } }));
      }
      return next();
    };
    void Promise.all(Array.from({ length: AT_ONCE }, next));
    return () => {
      live = false;
    };
    // `loaded` is read once per opening: a file already asked for isn't asked again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, files, connected, agentId, messageId]);

  const copyLive = !!changes?.copy && agent?.copy?.id === changes.copy.id;
  const copy = useCopyParts(
    copyLive && agent && changes?.copy
      ? {
          agent,
          copy: changes.copy,
          project: changes.project,
          leftOut: changes.leftOut,
          warning: changes.warning,
          onError: setError,
        }
      : null
  );

  const askAbout = useCallback(
    (path: string, row: DiffRow) => {
      const no = row.newNo ?? row.oldNo;
      showActions(
        `${splitPath(path).name}, line ${no}`,
        [
          { id: 'ask', title: 'Ask for a change here', icon: 'bubble.left' },
          { id: 'copy', title: 'Copy line', icon: 'doc.on.doc' },
        ],
        (id) => {
          if (id === 'copy') return void Clipboard.setStringAsync(row.text);
          const quotes = getApp().composer[agentId]?.quotes ?? [];
          setComposer(agentId, { quotes: [...quotes, lineQuote(path, row)] });
          router.dismissTo({ pathname: '/chat/[id]', params: { id: agentId } });
        }
      );
    },
    [agentId, router]
  );

  const openFile = (path: string) => {
    haptic.select();
    if (tab === 'files' && offsets.current[path] != null) {
      scroll.current?.scrollTo({ y: offsets.current[path], animated: true });
      return;
    }
    pendingJump.current = path;
    setTab('files');
  };

  if (!changes) {
    return (
      <T color={colors.textSecondary} style={styles.note}>
        This change isn’t in the saved chat any more.
      </T>
    );
  }

  // The order a reviewer wants: the change first, then its tests, then upkeep.
  const groups = reviewOrder(changes.files);
  const ordered = groups.flatMap((g) => g.files);
  const most = Math.max(1, ...changes.files.map((x) => (x.added ?? 0) + (x.removed ?? 0)));
  const done = changes.files.filter((f) => reviewed.has(f.path)).length;
  const total = changes.files.length;
  const toggle = (path: string, on: boolean) => {
    haptic.select();
    setReviewed(agentId, messageId, path, on);
  };

  const headerBlock = (
    <View key="head" style={styles.head}>
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
      <Progress done={done} total={total} />
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'overview', label: 'Overview' },
          { value: 'files', label: `Files ${total}` },
        ]}
      />
    </View>
  );

  // Files: a header per file (held at the top while its diff scrolls), then its body.
  const children: React.ReactNode[] = [headerBlock];
  const sticky: number[] = [];
  if (tab === 'files') {
    ordered.forEach((f) => {
      const group = groups.find((g) => g.files[0] === f);
      if (group && groups.length > 1)
        children.push(
          <T
            key={`g-${group.group}`}
            variant="caption"
            color={colors.textMuted}
            style={styles.groupTitle}
          >
            {group.title.toUpperCase()}
          </T>
        );
      sticky.push(children.length);
      children.push(
        <View
          key={`h-${f.path}`}
          onLayout={(e) => {
            offsets.current[f.path] = e.nativeEvent.layout.y;
            if (pendingJump.current === f.path) {
              pendingJump.current = null;
              const y = e.nativeEvent.layout.y;
              requestAnimationFrame(() => scroll.current?.scrollTo({ y, animated: false }));
            }
          }}
          style={styles.fileHeadWrap}
        >
          <FileHead
            file={f}
            reviewed={reviewed.has(f.path)}
            onToggle={(on) => toggle(f.path, on)}
          />
        </View>
      );
      const state = loaded[f.path];
      children.push(
        <View key={`b-${f.path}`} style={styles.fileBody}>
          {reviewed.has(f.path) ? null : !connected && !state ? (
            <T variant="small" color={colors.textSecondary}>
              Opening a file’s diff needs {comp.your}.
            </T>
          ) : !state || state === 'loading' ? (
            <View style={styles.pad}>
              <Spinner size={iconSize.body} />
            </View>
          ) : 'error' in state ? (
            <T variant="small" color={colors.accentErrorLight}>
              {state.error}
            </T>
          ) : state.diff.isBinary ? (
            <T variant="small" color={colors.textSecondary}>
              A binary file: there’s no text to compare.
            </T>
          ) : (
            <Animated.View entering={FadeIn.duration(180)}>
              <ReviewDiff
                content={state.diff.content}
                path={f.path}
                onLine={(row) => askAbout(f.path, row)}
              />
            </Animated.View>
          )}
        </View>
      );
    });
  } else {
    if (said) {
      const long = said.length > SAID_MAX;
      children.push(
        <View key="said" style={styles.said}>
          <T variant="caption" color={colors.textMuted}>
            {`What ${agent?.name ?? 'it'} said`}
          </T>
          <T color={colors.textPrimary} selectable>
            {long && !saidOpen ? `${said.slice(0, SAID_MAX).trimEnd()}…` : said}
          </T>
          {long && (
            <Pressable
              accessibilityRole="button"
              onPress={() => setSaidOpen((v) => !v)}
              hitSlop={space.sm}
            >
              <T variant="small" color={colors.textSecondary}>
                {saidOpen ? 'Show less' : 'Show all'}
              </T>
            </Pressable>
          )}
        </View>
      );
    }
    for (const g of groups) {
      if (groups.length > 1)
        children.push(
          <T
            key={`g-${g.group}`}
            variant="caption"
            color={colors.textMuted}
            style={styles.groupTitle}
          >
            {g.title.toUpperCase()}
          </T>
        );
      children.push(
        <View key={`list-${g.group}`} style={styles.group}>
          {g.files.map((f, i) => (
            <View key={f.path}>
              <FileRow
                file={f}
                reviewed={reviewed.has(f.path)}
                most={most}
                onPress={() => openFile(f.path)}
                onToggle={(on) => toggle(f.path, on)}
              />
              {i < g.files.length - 1 && <InsetDivider />}
            </View>
          ))}
        </View>
      );
    }
    children.push(
      <T key="hint" variant="caption" color={colors.textMuted} style={styles.hint}>
        Long press a line in Files to ask for a change there.
      </T>
    );
  }

  return (
    <SheetPage>
      <ScrollView
        ref={scroll}
        stickyHeaderIndices={sticky}
        contentContainerStyle={[styles.content, copy && { paddingBottom: space['2xl'] * 3 }]}
      >
        {children}
      </ScrollView>
      {copy && (
        <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
          {!!error && (
            <T variant="small" color={colors.accentErrorLight}>
              {error}
            </T>
          )}
          <View style={styles.barRow}>{copy.actions}</View>
        </View>
      )}
    </SheetPage>
  );
}

/** "3 of 5 reviewed" and a thin bar filled to it. */
function Progress({ done, total }: { done: number; total: number }) {
  const colors = useColors();
  const styles = useStyles();
  const all = total > 0 && done === total;
  return (
    <View
      style={{ gap: space.xs }}
      accessible
      accessibilityLabel={`${done} of ${total} files reviewed`}
    >
      <T variant="caption" color={all ? colors.textStrong : colors.textSecondary}>
        {all ? 'All files reviewed' : `${done} of ${total} reviewed`}
      </T>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${total ? (done / total) * 100 : 0}%` }]} />
      </View>
    </View>
  );
}

/** Five blocks, as a code host draws them: added and removed, in proportion to the biggest file. */
function Blocks({
  added = 0,
  removed = 0,
  most,
}: {
  added?: number;
  removed?: number;
  most: number;
}) {
  const colors = useColors();
  const styles = useStyles();
  const size = Math.max(1, Math.round(((added + removed) / most) * 5));
  const green = added + removed ? Math.round((added / (added + removed)) * size) : 0;
  return (
    <View style={styles.blocks} importantForAccessibility="no-hide-descendants">
      {Array.from({ length: 5 }, (_, i) => (
        <View
          key={i}
          style={[
            styles.block,
            {
              backgroundColor:
                i < green ? colors.diffAdd : i < size ? colors.diffDel : colors.borderDefault,
            },
          ]}
        />
      ))}
    </View>
  );
}

function Tick({
  on,
  onToggle,
  name,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  name: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`Reviewed ${name}`}
      hitSlop={space.md}
      onPress={() => onToggle(!on)}
    >
      <Icon
        name={on ? 'checkmark.circle.fill' : 'circle'}
        size={iconSize.body}
        color={on ? colors.textStrong : colors.textMuted}
      />
    </Pressable>
  );
}

function FileRow({
  file,
  reviewed,
  most,
  onPress,
  onToggle,
}: {
  file: ChangedFile;
  reviewed: boolean;
  most: number;
  onPress: () => void;
  onToggle: (on: boolean) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const { name, folder } = splitPath(file.path);
  return (
    <View style={styles.fileRow}>
      <Tick on={reviewed} onToggle={onToggle} name={name} />
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Opens its diff"
        onPress={onPress}
        style={({ pressed }) => [styles.fileMain, pressed && { opacity: 0.6 }]}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <T
            variant="small"
            color={reviewed ? colors.textSecondary : colors.textStrong}
            numberOfLines={1}
          >
            {name}
          </T>
          <T variant="caption" color={colors.textMuted} numberOfLines={1}>
            {folder ? `${STATUS[file.status]} · ${folder}` : STATUS[file.status]}
          </T>
        </View>
        <View style={styles.fileCounts}>
          <T variant="caption" color={colors.textMuted} style={styles.count}>
            {!!file.added && <T variant="caption" color={colors.diffAdd}>{`+${file.added}`}</T>}
            {!!file.removed && (
              <T variant="caption" color={colors.diffDel}>{` −${file.removed}`}</T>
            )}
          </T>
          <Blocks added={file.added} removed={file.removed} most={most} />
        </View>
        <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

function FileHead({
  file,
  reviewed,
  onToggle,
}: {
  file: ChangedFile;
  reviewed: boolean;
  onToggle: (on: boolean) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const { name, folder } = splitPath(file.path);
  return (
    <View style={styles.fileHead}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="small" color={colors.textStrong} numberOfLines={1}>
          {name}
          {!!folder && <T variant="caption" color={colors.textMuted}>{`  ${folder}`}</T>}
        </T>
      </View>
      <T variant="caption" color={colors.textMuted} style={styles.count}>
        {!!file.added && <T variant="caption" color={colors.diffAdd}>{`+${file.added}`}</T>}
        {!!file.removed && <T variant="caption" color={colors.diffDel}>{` −${file.removed}`}</T>}
      </T>
      <Tick on={reviewed} onToggle={onToggle} name={name} />
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  content: { padding: space.lg, paddingTop: space.xl, gap: space.md, paddingBottom: space['2xl'] },
  head: { gap: space.md, paddingBottom: space.xs },
  note: { padding: space.xl, textAlign: 'center' },
  group: groupSurface(colors),
  count: { fontVariant: ['tabular-nums'] },
  said: { ...groupSurface(colors), padding: space.lg, gap: space.xs },
  hint: { textAlign: 'center' },
  groupTitle: { marginTop: space.sm, marginBottom: -space.xs, letterSpacing: 0.4 },
  track: {
    height: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.borderDefault,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.textStrong },
  fileRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: space.lg, gap: space.md },
  fileMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingRight: space.lg,
    paddingVertical: space.md,
    minHeight: space['2xl'] + space.lg,
  },
  fileCounts: { alignItems: 'flex-end', gap: space.xs },
  blocks: { flexDirection: 'row', gap: space['2xs'] },
  block: { width: space.tight, height: space.tight, borderRadius: radius.sm },
  // Held at the top while its file scrolls: the page's own colour behind it.
  fileHeadWrap: {
    backgroundColor: colors.surfacePanel,
    marginHorizontal: -space.lg,
    paddingHorizontal: space.lg,
  },
  fileHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefault,
  },
  fileBody: { marginTop: -space.xs },
  pad: { padding: space.md },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.sm,
    backgroundColor: colors.surfacePanel,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  barRow: { flexDirection: 'row', gap: space.sm, justifyContent: 'flex-end' },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
