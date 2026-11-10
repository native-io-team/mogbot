/**
 * Search every conversation on the Mac, grouped by agent, newest first, with
 * the matched words picked out. A hit opens its chat scrolled to that
 * message, paging back through history to reach it if it has to.
 */

import type { SearchHit } from '@shipstudio/companion-protocol';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Spinner } from '../../../components/agent';
import { AgentKey } from '../../../components/AgentKey';
import { Icon, T } from '../../../components/ui';
import { formatAgo, plainSnippet } from '../../../lib/agents';
import { roomsOffered } from '../../../lib/rooms';
import { canCall, describeError, search } from '../../../lib/session';
import { useApp } from '../../../lib/store';
import { keySize, fonts, iconSize, space } from '../../../lib/theme';
import { useColors } from '../../../lib/appearance';

interface Group {
  key: string;
  name: string;
  color: string;
  /** A room's hits: drawn with the room mark, not one agent's badge. */
  room: boolean;
  data: SearchHit[];
}

/**
 * Hits arrive newest first; groups keep that order by their newest hit. A
 * hit said in a room groups under the room (on a phone that shows rooms).
 */
function groupHits(hits: SearchHit[], rooms: boolean): Group[] {
  const groups = new Map<string, Group>();
  for (const h of hits) {
    if (h.roomId && !rooms) continue;
    const key = h.roomId ? `room:${h.roomId}` : h.agentId;
    const g = groups.get(key) ?? {
      key,
      name: h.roomId ? (h.roomName ?? 'Room') : h.agentName,
      color: h.agentColor,
      room: !!h.roomId,
      data: [],
    };
    g.data.push(h);
    groups.set(key, g);
  }
  return [...groups.values()];
}

const WHO: Partial<Record<SearchHit['kind'], string>> = {
  user: 'You',
  agent: 'Reply',
  check_in: 'Routine',
  session: 'Task',
  note: 'Note',
};

export default function Search() {
  const colors = useColors();
  const router = useRouter();
  const served = useApp((s) => canCall('agents.search', s.welcome));
  const rooms = useApp((s) => roomsOffered(s.welcome));
  // `?q=` starts with a query: a link into a search, and the web QA (no
  // native search bar there to type into).
  const { q: initial } = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(typeof initial === 'string' ? initial : '');
  const [answer, setAnswer] = useState<{ q: string; hits?: SearchHit[]; error?: string } | null>(
    null
  );
  const q = query.trim();
  const active = served && q.length >= 2;

  useEffect(() => {
    if (!active) return;
    let live = true;
    const timer = setTimeout(() => {
      search(q).then(
        (hits) => live && setAnswer({ q, hits }),
        (e: unknown) => live && setAnswer({ q, error: describeError(e) })
      );
    }, 220);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, active]);

  // While the next answer is on its way, the last one stays on screen.
  const busy = active && answer?.q !== q;
  const hits = active ? (answer?.hits ?? null) : null;
  const error = active && !busy ? (answer?.error ?? null) : null;

  const sections = useMemo(() => groupHits(hits ?? [], rooms), [hits, rooms]);
  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);

  // Once per palette, not per keystroke: see `largeTitle` in lib/navigation.
  const screenOptions = useMemo(
    () => ({
      title: 'Search',
      headerLargeTitle: true,
      headerLargeTitleStyle: { fontFamily: fonts.semibold, color: colors.textStrong },
      headerSearchBarOptions: {
        placeholder: 'Search conversations',
        autoCapitalize: 'none' as const,
        hideWhenScrolling: false,
        textColor: colors.textStrong,
        onChangeText: (e: { nativeEvent: { text: string } }) => setQuery(e.nativeEvent.text),
      },
    }),
    [colors]
  );

  return (
    <>
      <Stack.Screen options={screenOptions} />
      <SectionList
        sections={sections}
        keyExtractor={(h) => `${h.agentId}:${h.messageId}`}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: space['2xl'] }}
        renderSectionHeader={({ section }) => (
          <View style={styles.group}>
            {section.room ? (
              <Icon name="person.2" size={iconSize.inline} color={colors.textSecondary} />
            ) : (
              <AgentKey
                id={section.key}
                name={section.name}
                color={section.color}
                size={keySize.sm}
              />
            )}
            <T
              variant="small"
              color={colors.textStrong}
              style={{ flex: 1, fontFamily: fonts.semibold }}
            >
              {section.name}
            </T>
            <T variant="caption" color={colors.textMuted}>
              {section.data.length}
            </T>
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              if (item.roomId) {
                router.push({ pathname: '/room/[id]', params: { id: item.roomId } });
                return;
              }
              router.push({
                pathname: '/chat/[id]',
                // Said in another of its conversations: the chat opens that one.
                params: {
                  id: item.agentId,
                  at: item.messageId,
                  ...(item.conversation ? { conversation: item.conversation } : {}),
                },
              });
            }}
            style={({ pressed }) => [
              styles.hit,
              pressed && { backgroundColor: colors.surfaceControl },
            ]}
          >
            <View style={styles.hitTop}>
              <T variant="caption" color={colors.textMuted}>
                {item.roomId
                  ? item.agentName || 'You'
                  : (item.peerName ?? WHO[item.kind] ?? item.agentName)}
              </T>
              <T variant="caption" color={colors.textMuted}>
                {formatAgo(item.ts)}
              </T>
            </View>
            <Highlighted text={plainSnippet(item.snippet)} words={words} />
          </Pressable>
        )}
        ListEmptyComponent={
          <Animated.View entering={FadeIn.delay(150)} style={styles.empty}>
            {!served ? (
              <EmptyNote
                title="Search needs an update"
                body="Update the app on your Mac to search your conversations from here."
              />
            ) : busy && !hits ? (
              <Spinner />
            ) : error ? (
              <T color={colors.accentErrorLight}>{error}</T>
            ) : hits ? (
              <EmptyNote
                title={`Nothing matches “${q}”`}
                body="Every word has to match, so try fewer or shorter ones."
              />
            ) : (
              <EmptyNote
                icon
                title="Find anything that was said"
                body="Every conversation with every agent, yours and theirs. Try a name, a topic or a phrase."
              />
            )}
          </Animated.View>
        }
      />
    </>
  );
}

/** What the page says when there are no hits to show: a title and one line. */
function EmptyNote({ title, body, icon }: { title: string; body: string; icon?: boolean }) {
  const colors = useColors();
  return (
    <View style={styles.emptyNote}>
      {icon && (
        <View style={styles.emptyIcon}>
          <Icon name="magnifyingglass" size={iconSize.hero} color={colors.textMuted} />
        </View>
      )}
      <View style={styles.emptyWords}>
        <T variant="title" color={colors.textStrong} style={styles.centerText}>
          {title}
        </T>
        <T color={colors.textSecondary} style={styles.centerText}>
          {body}
        </T>
      </View>
    </View>
  );
}

/** The snippet with each searched word in white. */
function Highlighted({ text, words }: { text: string; words: string[] }) {
  const colors = useColors();
  const parts = useMemo(() => {
    if (!words.length) return [{ text, on: false }];
    const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return text
      .split(new RegExp(`(${escaped.join('|')})`, 'gi'))
      .filter(Boolean)
      .map((t) => ({ text: t, on: words.includes(t.toLowerCase()) }));
  }, [text, words]);
  return (
    <T variant="small" color={colors.textSecondary} numberOfLines={3}>
      {parts.map((p, i) =>
        p.on ? (
          <T key={i} variant="small" color={colors.textStrong} style={{ fontFamily: fonts.medium }}>
            {p.text}
          </T>
        ) : (
          p.text
        )
      )}
    </T>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.tight,
  },
  hit: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space['2xs'] },
  hitTop: { flexDirection: 'row', justifyContent: 'space-between' },
  empty: { padding: space.xl, paddingTop: space['2xl'] * 2, alignItems: 'center' },
  emptyNote: { alignItems: 'center', maxWidth: 320 },
  emptyIcon: { marginBottom: space.md },
  emptyWords: { alignItems: 'center', gap: space.tight },
  centerText: { textAlign: 'center' },
});

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../../../components/ScreenError';
