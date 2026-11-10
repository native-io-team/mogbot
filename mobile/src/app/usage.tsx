/**
 * Usage, from the ring in a chat's header: this agent's context, then the
 * whole stack of accounts as the desk's Usage view shows it (one line, a
 * segmented meter, each account as a card with its limits, who used it and
 * where its usage went; components/usageStack.tsx). From an older Mac, the
 * account the turns run on and every other account with its own limits. Each reading shows once: the top
 * account is never listed again under it (lib/usageSheet.ts `usageSheet`). Only what the Mac serves
 * (lib/usageSheet.ts): a section with no reading isn't drawn. The one
 * estimate, the pace line under a limit, is the Mac's (`UsagePace`) and says
 * it is one. ↻ reads it all again.
 */

import {
  usageGlance,
  type AccountBlock,
  type UsageInventory,
} from '@shipstudio/companion-protocol';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Spinner } from '../components/agent';
import { SheetTitle } from '../components/SheetTitle';
import { ComputeAccount, ComputeQuiet, ComputeSummary, MeterRow } from '../components/usage';
import { GlanceCard, KeyCard } from '../components/usageStack';
import { useAccounts } from '../lib/accounts';
import { IconButton, Section, SectionTitle, SheetPage, T } from '../components/ui';
import { engineName } from '../lib/agents';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { useQuotas } from '../lib/quota';
import { call, canCall } from '../lib/session';
import { asOverview } from '../lib/wellFormed';
import { setApp, useApp } from '../lib/store';
import { iconSize, space } from '../lib/theme';
import { usePolling } from '../lib/usePolling';
import { accountBlocks, computeView, contextMeter, usageSheet } from '../lib/usageSheet';

export default function Usage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const colors = useColors();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === id));
  const connected = useApp((s) => s.link.kind === 'connected');
  const { quotas, now, read: readQuotas } = useQuotas();
  const servesPlan = canCall('agents.usagePlan');
  const [inventory, setInventory] = useState<UsageInventory | null>(null);
  const readPlan = useCallback(async () => {
    if (!servesPlan) return;
    try {
      setInventory(await call('agents.usagePlan', {}));
    } catch {
      // Unanswered: keep what was last read.
    }
  }, [servesPlan]);
  usePolling(readPlan, 60_000);

  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing || !connected) return;
    haptic.light();
    setRefreshing(true);
    try {
      await Promise.all([
        readQuotas(),
        readPlan(),
        // The context figure rides on the agent's row.
        call('agents.overview', {}).then((raw) => {
          const overview = asOverview(raw);
          if (overview) setApp({ overview });
        }),
      ]);
    } catch {
      // Whatever came back is shown; the rest keeps its last reading.
    } finally {
      setRefreshing(false);
    }
  };

  const context = contextMeter(agent?.context);
  const engine = agent?.engine;
  const { active, others } = useMemo(
    () =>
      engine
        ? usageSheet(quotas, engine, inventory, now)
        : { active: null, others: accountBlocks(inventory, now) },
    [quotas, engine, inventory, now]
  );
  // Every account at once, from a Mac that serves it: each reading once,
  // the account turns run on next marked in the list.
  const total = useMemo(() => computeView(inventory, now), [inventory, now]);
  // The stack of accounts, as the desk's Usage view says it: from a Mac
  // that serves its accounts and their readings.
  const { accounts } = useAccounts({ room: false });
  const glance = useMemo(
    () => (accounts && inventory ? usageGlance(accounts, inventory, { now }) : null),
    [accounts, inventory, now]
  );
  const stacked = glance !== null && glance.keys.length > 0;
  const nothing = !context && !total && !stacked && !active && others.length === 0;

  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.page}>
        <SheetTitle
          trailing={
            refreshing ? (
              <View style={styles.spin}>
                <Spinner size={iconSize.body} label="Refreshing" />
              </View>
            ) : (
              <IconButton
                name="arrow.clockwise"
                label="Refresh"
                size={iconSize.body}
                onPress={() => void refresh()}
              />
            )
          }
        >
          Usage
        </SheetTitle>

        {context && (
          <Section title="Conversation length">
            <View style={styles.block}>
              <MeterRow
                meter={context}
                title={agent ? `${agent.name}’s conversation` : 'Conversation'}
              />
            </View>
          </Section>
        )}

        {stacked && glance && (
          <View style={styles.accounts}>
            <SectionTitle title="Your accounts" />
            <GlanceCard glance={glance} />
            {glance.keys.map((k) => (
              <KeyCard key={k.key} k={k} />
            ))}
          </View>
        )}

        {!stacked && total && (
          // Each account its own card, not one long group: the headline
          // answers first, then every card reads on its own.
          <View style={styles.accounts}>
            <SectionTitle title="All accounts" />
            <ComputeSummary view={total} />
            {total.rows.map((r) => (
              <ComputeAccount key={r.key} row={r} />
            ))}
            {total.quiet.length > 0 && <ComputeQuiet rows={total.quiet} />}
          </View>
        )}

        {!stacked && !total && active && agent && (
          <Section title={`Plan usage · ${engineName(agent)}`}>
            <View style={styles.block}>
              {active.account && (
                <T variant="small" color={colors.textMuted}>
                  {active.account}
                </T>
              )}
              {active.state && (
                <T
                  variant="small"
                  color={active.tone === 'calm' ? colors.textSecondary : colors.accentWarning}
                >
                  {active.state}
                </T>
              )}
              {active.meters.map((m) => (
                <MeterRow key={m.key} meter={m} />
              ))}
            </View>
          </Section>
        )}

        {!stacked && !total && others.length > 0 && (
          <Section title={active ? 'Other accounts' : 'Accounts'}>
            {others.map((a, i) => (
              <AccountRows key={a.key} account={a} divided={i > 0} />
            ))}
          </Section>
        )}

        {nothing && (
          <T color={colors.textSecondary}>
            {connected
              ? 'Nothing reported yet. Figures appear once an engine reports them after a turn.'
              : 'Your Mac is away. Usage shows once it’s back.'}
          </T>
        )}
        {!nothing && (
          <T variant="small" color={colors.textMuted}>
            As each account last reported it. Use of the same plan anywhere else counts too.
          </T>
        )}
      </ScrollView>
    </SheetPage>
  );
}

function AccountRows({ account: a, divided }: { account: AccountBlock; divided: boolean }) {
  const styles = useStyles();
  const colors = useColors();
  return (
    <View style={[styles.block, divided && styles.divided]}>
      <View style={styles.accountHead}>
        <T variant="headline" color={colors.textStrong} numberOfLines={1}>
          {a.title}
        </T>
        {a.tags.length > 0 && (
          <T variant="small" color={colors.textMuted}>
            {a.tags.join(' · ')}
          </T>
        )}
      </View>
      {a.state && (
        <T variant="small" color={a.tone === 'calm' ? colors.textSecondary : colors.accentWarning}>
          {a.state}
        </T>
      )}
      {a.meters.map((m) => (
        <MeterRow key={m.key} meter={m} />
      ))}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { padding: space.lg, gap: space.xs },
  block: { gap: space.md, padding: space.lg },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDefault },
  accountHead: { gap: space['2xs'] },
  accounts: { gap: space.md, marginBottom: space.xl },
  spin: { padding: space.sm },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
