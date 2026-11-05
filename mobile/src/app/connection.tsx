/**
 * Every layer of the link, in order, each ok / a problem / unknown. What the
 * phone can't observe is said to be unknown, never guessed.
 */

import type { Device } from '@shipstudio/companion-protocol';

import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLinkState, useNow } from '../components/ConnectionPill';
import { Button, Dot, Section, T, useToneColor, SheetPage, InsetDivider } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { engineName, formatAgo, formatDate } from '../lib/agents';
import { layers, pill } from '../lib/connection';
import { appInfo, openTailscale } from '../lib/pairing';
import { currentTransport, deviceSelf } from '../lib/session';
import { space } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';

export default function Connection() {
  const colors = useColors();
  const styles = useStyles();
  const toneColor = useToneColor();
  const now = useNow(5_000);
  const state = useLinkState();
  const [device, setDevice] = useState<Device | null>(null);
  const connected = state.link.kind === 'connected';
  useEffect(() => {
    if (connected) deviceSelf().then(setDevice, () => {});
  }, [connected]);

  const t = currentTransport();
  const p = pill(state, now);
  const rows = layers(
    state,
    { latencyMs: t?.latencyMs ?? null, lastSeenAt: t?.lastSeenAt ?? 0 },
    now
  );
  const failures = (state.overview?.agents ?? []).filter((a) => a.failure);

  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.head}>
          <SheetTitle>{state.credentials?.name ?? 'Your Mac'}</SheetTitle>
          <View style={styles.headLine}>
            <Dot color={toneColor[p.tone]} />
            <T variant="small" color={colors.textSecondary}>
              {p.label}
            </T>
          </View>
          {state.refusal && (
            <T variant="small" color={colors.accentErrorLight}>
              {state.refusal.message}
            </T>
          )}
        </View>

        <Section>
          {rows.map((layer, i) => (
            <View key={layer.title} style={styles.layer}>
              <View style={styles.dot}>
                <Dot color={toneColor[layer.tone]} />
              </View>
              <View style={{ flex: 1, gap: space['2xs'] }}>
                <T color={colors.textBody}>{layer.title}</T>
                <T variant="small" color={colors.textMuted}>
                  {layer.detail}
                </T>
              </View>
              {i < rows.length - 1 && <InsetDivider />}
            </View>
          ))}
        </Section>

        {failures.length > 0 && (
          <Section title="Agents">
            {failures.map((a, i) => (
              <View key={a.id} style={styles.layer}>
                <View style={styles.dot}>
                  <Dot
                    color={
                      a.failure?.kind === 'usage_limit' ? colors.accentWarning : colors.accentError
                    }
                  />
                </View>
                <View style={{ flex: 1, gap: space['2xs'] }}>
                  <T color={colors.textBody}>{a.name}</T>
                  <T variant="small" color={colors.textMuted}>
                    {a.failure?.kind === 'signed_out'
                      ? `Last turn failed: ${engineName(a)} is signed out`
                      : a.failure?.kind === 'usage_limit'
                        ? 'At its usage limit'
                        : 'Last turn didn’t finish'}
                    {a.capabilities ? ` · as of ${formatAgo(a.capabilities.seenAt, now)}` : ''}
                  </T>
                </View>
                {i < failures.length - 1 && <InsetDivider />}
              </View>
            ))}
          </Section>
        )}

        <Section title="This phone">
          <Info label="Name" value={device?.name ?? 'Unknown until connected'} />
          <Info
            label="Paired"
            value={state.credentials ? formatDate(state.credentials.pairedAt) : '—'}
          />
          <Info label="App" value={`${appInfo().version} (${appInfo().build})`} last />
        </Section>

        {!connected && (
          <Button title="Open Tailscale" icon="network" onPress={() => void openTailscale()} />
        )}
      </ScrollView>
    </SheetPage>
  );
}

function Info({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.info}>
      <T color={colors.textBody}>{label}</T>
      <T color={colors.textSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>
        {value}
      </T>
      {!last && <InsetDivider />}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  page: { padding: space.lg, paddingTop: space.xl, gap: space.xs },
  head: { gap: space.tight, marginBottom: space.lg, paddingHorizontal: space.xs },
  headLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  layer: { flexDirection: 'row', gap: space.md, padding: space.lg, alignItems: 'flex-start' },
  // Centred on the title's first line: (24 line − 8 dot) / 2.
  dot: { paddingTop: space.sm },
  info: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, padding: space.lg },
}));
