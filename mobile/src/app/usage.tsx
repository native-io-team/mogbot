/**
 * Usage, from the ring in a chat's header: this agent's context, its
 * engine's plan (the 5-hour and weekly limits) and every account the
 * Mac knows, each with its limits. Only what the Mac serves
 * (lib/usageSheet.ts): a section with no reading isn't drawn, and nothing is
 * estimated. ↻ reads it all again.
 */

import type { UsageInventory } from '@shipstudio/companion-protocol';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Spinner } from '../components/agent';
import { SheetTitle } from '../components/SheetTitle';
import { MeterRow } from '../components/usage';
import { IconButton, Section, SheetPage, T } from '../components/ui';
import { engineName } from '../lib/agents';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { useQuotas } from '../lib/quota';
import { call, canCall } from '../lib/session';
import { setApp, useApp } from '../lib/store';
import { iconSize, space } from '../lib/theme';
import { usePolling } from '../lib/usePolling';
import { accountBlocks, contextMeter, planUsage } from '../lib/usageSheet';

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
        call('agents.overview', {}).then((overview) => setApp({ overview })),
      ]);
    } catch {
      // Whatever came back is shown; the rest keeps its last reading.
    } finally {
      setRefreshing(false);
    }
  };

  const context = contextMeter(agent?.context);
  const plan = agent ? planUsage(quotas, agent.engine, now) : null;
  const accounts = useMemo(() => accountBlocks(inventory, now), [inventory, now]);
  const nothing = !context && !plan && accounts.length === 0;

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
          <Section title="Context">
            <View style={styles.block}>
              <MeterRow
                meter={context}
                title={agent ? `${agent.name}’s conversation` : 'Conversation'}
              />
            </View>
          </Section>
        )}

        {plan?.session && agent && (
          <Section title={`Plan usage · ${engineName(agent)}`}>
            <View style={styles.block}>
              <MeterRow meter={plan.session} />
            </View>
          </Section>
        )}

        {plan && plan.weekly.length > 0 && (
          <Section title="Weekly limits">
            <View style={styles.block}>
              {plan.weekly.map((m) => (
                <MeterRow key={m.key} meter={m} />
              ))}
            </View>
          </Section>
        )}

        {accounts.length > 0 && (
          <Section title="Accounts">
            {accounts.map((a, i) => (
              <View key={a.key} style={[styles.block, i > 0 && styles.divided]}>
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
                  <T
                    variant="small"
                    color={a.tone === 'calm' ? colors.textSecondary : colors.accentWarning}
                  >
                    {a.state}
                  </T>
                )}
                {a.meters.map((m) => (
                  <MeterRow key={m.key} meter={m} />
                ))}
              </View>
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
            As each engine last reported it. Use of the same plan anywhere else counts too.
          </T>
        )}
      </ScrollView>
    </SheetPage>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { padding: space.lg, gap: space.xs },
  block: { gap: space.md, padding: space.lg },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDefault },
  accountHead: { gap: space['2xs'] },
  spin: { padding: space.sm },
}));
