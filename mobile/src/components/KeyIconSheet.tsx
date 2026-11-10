/**
 * Every icon an agent's key can wear (docs/internal/agent-keys.md, "The icon
 * pack"), in a sheet: the key at full size on top (it changes as you tap),
 * a search that's focused when the sheet opens, the categories as chips,
 * the icons picked lately, and a virtualised grid of keys. The search is
 * the desk's (`searchIcons`): names, tags, synonyms and one typo, so
 * "money", "invoice" or "house" each find good keys.
 *
 * The pack (its index and drawings) loads when the sheet first opens,
 * never at launch.
 */

import {
  FEATURED_CATEGORY,
  featuredEntries,
  iconName,
  loadAllPackDrawings,
  loadIconCatalog,
  searchIcons,
  type IconCatalog,
  type IconEntry,
} from '@shipstudio/companion-protocol';
import { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeStyles, useColors } from '../lib/appearance';
import { fonts, keySize, lineHeight, radius, space, type } from '../lib/theme';
import { AgentKey } from './AgentKey';
import { Chip } from './pickers';
import { Button, T, tap } from './ui';

/** A tile: the small key with room round it for its ring, a 44pt target. */
const TILE = keySize.md + 14;
const RECENT_MAX = 10;

/** The icons picked lately, for as long as the app runs. */
let recentIcons: string[] = [];

/** Puts an icon first in the recent row, and returns the row. */
function remember(id: string): string[] {
  recentIcons = [id, ...recentIcons.filter((v) => v !== id)].slice(0, RECENT_MAX);
  return recentIcons;
}

const FEATURED_ONLY: IconCatalog = {
  entries: featuredEntries(),
  categories: [{ id: FEATURED_CATEGORY, title: 'Featured' }],
};

export function KeyIconSheet({
  visible,
  name,
  colorway,
  icon,
  boundKey,
  onPick,
  onClose,
}: {
  visible: boolean;
  name: string;
  colorway: string;
  icon: string;
  boundKey: string | null;
  onPick: (icon: string) => void;
  onClose: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [catalog, setCatalog] = useState<IconCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [recent, setRecent] = useState(recentIcons);

  useEffect(() => {
    if (!visible || catalog) return;
    let live = true;
    Promise.all([loadIconCatalog(), loadAllPackDrawings()])
      .then(([c]) => live && setCatalog(c))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [visible, catalog]);

  const shown = catalog ?? FEATURED_ONLY;
  const results = useMemo(() => searchIcons(shown, query, category), [shown, query, category]);
  const columns = Math.max(4, Math.floor((width - space.lg * 2) / TILE));
  const browsing = !query.trim() && !category;
  const count = results.length.toLocaleString('en');

  const pick = (id: string) => {
    if (id !== icon) tap();
    onPick(id);
    setRecent(remember(id));
  };

  const tile = (e: IconEntry | string, recentRow = false) => {
    const id = typeof e === 'string' ? e : e.id;
    const on = id === icon && !recentRow;
    return (
      <Pressable
        key={recentRow ? `recent-${id}` : id}
        accessibilityRole="radio"
        accessibilityLabel={recentRow ? `${iconName(id)}, recently used` : iconName(id)}
        accessibilityState={{ selected: on }}
        onPress={() => pick(id)}
        style={styles.tile}
      >
        <View style={[styles.ring, on && { borderColor: colors.textStrong }]}>
          <AgentKey name={name} colorway={colorway} icon={id} size={keySize.md} />
        </View>
      </Pressable>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.page, { paddingBottom: insets.bottom }]}>
        <View style={styles.head}>
          <T variant="subhead" color={colors.textStrong}>
            Icon
          </T>
          <Button title="Done" variant="ghost" size="compact" onPress={onClose} />
        </View>
        <View style={styles.preview}>
          <AgentKey
            name={name}
            colorway={colorway}
            icon={icon}
            boundKey={boundKey}
            size={keySize.xl}
          />
          <T variant="caption" color={colors.textSecondary}>
            {iconName(icon)}
          </T>
        </View>
        <TextInput
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          returnKeyType="done"
          onSubmitEditing={() => results[0] && pick(results[0].id)}
          placeholder={catalog ? `Search ${count} icons: money, mail, house…` : 'Search icons'}
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Search icons"
          style={styles.search}
        />
        {catalog && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.filters}
            style={styles.filterStrip}
          >
            <Chip label="All" selected={category === null} onPress={() => setCategory(null)} />
            {catalog.categories.map((c) => (
              <Chip
                key={c.id}
                label={c.title}
                selected={category === c.id}
                onPress={() => setCategory(category === c.id ? null : c.id)}
              />
            ))}
          </ScrollView>
        )}
        <T variant="caption" color={colors.textSecondary} style={styles.count}>
          {!catalog && !failed
            ? 'Loading every icon…'
            : failed
              ? 'Only the featured icons are here: the rest didn’t load.'
              : results.length === 0
                ? `Nothing matches “${query.trim()}”. Try a plainer word for what it’s for.`
                : query.trim()
                  ? `${count} for “${query.trim()}”`
                  : `${count} icons`}
        </T>
        <FlatList
          key={columns}
          data={results}
          keyExtractor={(e) => e.id}
          numColumns={columns}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          initialNumToRender={columns * 8}
          maxToRenderPerBatch={columns * 6}
          windowSize={7}
          removeClippedSubviews
          accessibilityRole="radiogroup"
          accessibilityLabel="Icons"
          contentContainerStyle={styles.grid}
          ListHeaderComponent={
            browsing && recent.length > 0 ? (
              <View style={styles.recent}>
                <T variant="caption" color={colors.textSecondary}>
                  Recently used
                </T>
                <View style={styles.recentRow}>{recent.map((id) => tile(id, true))}</View>
                <T variant="caption" color={colors.textSecondary}>
                  All icons
                </T>
              </View>
            ) : undefined
          }
          renderItem={({ item }) => tile(item)}
        />
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { flex: 1, backgroundColor: colors.surfacePanel, paddingTop: space.md },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  preview: { alignItems: 'center', gap: space.xs, paddingBottom: space.md },
  search: {
    marginHorizontal: space.lg,
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.35),
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  filterStrip: { flexGrow: 0, marginTop: space.sm },
  filters: { gap: space.xs, paddingHorizontal: space.lg },
  count: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  grid: { paddingHorizontal: space.lg, paddingBottom: space.lg },
  recent: { gap: space.xs, paddingBottom: space.xs },
  recentRow: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center' },
  ring: {
    width: TILE - 2,
    height: TILE - 2,
    borderRadius: radius.control,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
