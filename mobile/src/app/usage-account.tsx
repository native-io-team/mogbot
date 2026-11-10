/**
 * One account's usage, opened from a row or a segment of the total on the
 * Usage screen: "‹ Usage", its name as the title,
 * then the desk's account page (components/usageStack.tsx `KeyCard`): its
 * place and state with "Use this one now" and its place in the order, its
 * limits each against pace or who used it this week (Limits | Tokens), and
 * where its usage went. Only what the Mac served (`usageGlance`, as the
 * desk's account page says it).
 */

import type { UsageInventory } from '@shipstudio/companion-protocol';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SheetTitle } from '../components/SheetTitle';
import { KeyCard, type KeyActions } from '../components/usageStack';
import { Icon, SheetPage, T } from '../components/ui';
import { idsOf, useAccounts } from '../lib/accounts';
import { makeStyles, useColors } from '../lib/appearance';
import { glanceFor } from '../lib/glance';
import { useApp } from '../lib/store';
import { call, canCall } from '../lib/session';
import { iconSize, PRESSED, space } from '../lib/theme';
import { usePolling } from '../lib/usePolling';

export default function UsageAccount() {
  const { engine, account } = useLocalSearchParams<{ engine: string; account: string }>();
  const styles = useStyles();
  const colors = useColors();
  const [inventory, setInventory] = useState<UsageInventory | null>(null);
  const serves = canCall('agents.usagePlan');
  const read = useCallback(async () => {
    if (!serves) return;
    try {
      setInventory(await call('agents.usagePlan', {}));
    } catch {
      // Unanswered: keep what was last read.
    }
  }, [serves]);
  usePolling(read, 60_000);
  const state = useAccounts({ room: false });
  const { accounts } = state;
  const agents = useApp((s) => s.overview?.agents);
  // The same glance as Usage and the Agents list: the same accounts, the same pins.
  const glance = useMemo(
    () => (accounts && inventory ? glanceFor(accounts, inventory, agents) : null),
    [accounts, inventory, agents]
  );
  const key = glance?.keys.find((k) => k.engine === engine && k.id === account) ?? null;
  // "May be the same account as …": the question about this one, said on its page too.
  const maybe = key
    ? (glance?.sameNotes ?? []).filter(
        (n) => n.includes(' may be the same ') && n.includes(key.name)
      )
    : [];

  // What the desk's page offers, where the Mac takes it from the phone.
  const actions = useMemo((): KeyActions => {
    if (!key || !accounts) return {};
    const ids = idsOf(accounts, key.engine);
    const i = ids.indexOf(key.id);
    const order = state.canReorder && ids.length > 1 && i >= 0;
    return {
      onUse: key.canUse && state.canSwap ? () => void state.swapTo(key.engine, key.id) : undefined,
      onMoveUp: order && i > 0 ? () => void state.move(key.engine, i, -1) : undefined,
      onMoveDown: order && i < ids.length - 1 ? () => void state.move(key.engine, i, 1) : undefined,
      busy: state.busy,
    };
  }, [key, accounts, state]);

  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.page}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to Usage"
          hitSlop={space.sm}
          onPress={() => router.back()}
          style={({ pressed }) => [styles.crumbs, pressed && PRESSED]}
        >
          <Icon name="chevron.left" size={iconSize.inline} color={colors.textSecondary} />
          <T variant="small" color={colors.textSecondary}>
            Usage
          </T>
        </Pressable>
        <SheetTitle numberOfLines={1}>{key?.name ?? 'Account'}</SheetTitle>
        {key ? (
          <>
            <KeyCard k={key} actions={actions} all={glance?.keys ?? []} />
            {maybe.map((n) => (
              <T key={n} variant="small" color={colors.textSecondary}>
                {n}
              </T>
            ))}
          </>
        ) : (
          <T color={colors.textSecondary}>
            {inventory ? 'This account isn’t on your Mac anymore.' : 'Reading it from your Mac…'}
          </T>
        )}
        {state.error && (
          <T variant="small" color={colors.accentErrorLight}>
            {state.error}
          </T>
        )}
        <View style={styles.foot}>
          <T variant="small" color={colors.textMuted}>
            As this account last reported it. Use of the same plan anywhere else counts too.
          </T>
        </View>
      </ScrollView>
    </SheetPage>
  );
}

const useStyles = makeStyles(() => ({
  page: { padding: space.lg, gap: space.md, paddingBottom: space['2xl'] },
  crumbs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
    minHeight: space['2xl'],
  },
  foot: { paddingTop: space.sm },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
