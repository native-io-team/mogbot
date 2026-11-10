/**
 * One account's usage, opened from a row or a segment of the total on the
 * Usage screen (or Settings → Accounts): "Usage › Work", then its card
 * (components/usageStack.tsx `KeyCard`): its limits against pace, who used
 * it this week and where its usage went. Only what the Mac served
 * (`usageGlance`, as the desk's account page says it).
 */

import { usageGlance, type UsageInventory } from '@shipstudio/companion-protocol';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SheetTitle } from '../components/SheetTitle';
import { KeyCard } from '../components/usageStack';
import { Icon, SheetPage, T } from '../components/ui';
import { useAccounts } from '../lib/accounts';
import { makeStyles, useColors } from '../lib/appearance';
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
  const { accounts } = useAccounts({ room: false });
  const key = useMemo(() => {
    if (!accounts || !inventory) return null;
    return (
      usageGlance(accounts, inventory).keys.find((k) => k.engine === engine && k.id === account) ??
      null
    );
  }, [accounts, inventory, engine, account]);

  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.page}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to Usage"
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
          <KeyCard k={key} titled={false} />
        ) : (
          <T color={colors.textSecondary}>
            {inventory ? 'This account isn’t on your Mac anymore.' : 'Reading it from your Mac…'}
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
  page: { padding: space.lg, gap: space.md },
  crumbs: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start' },
  foot: { paddingTop: space.sm },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
