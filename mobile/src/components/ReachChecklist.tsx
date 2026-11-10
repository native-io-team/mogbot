/**
 * "Can't reach your Mac" as a short checklist (`lib/reachChecklist.ts`):
 * one row per thing that has to be true, a dot for what the phone can see
 * of it, the fix under it, and that row's one button. The address that was
 * tried sits folded under "Details", never in the first line.
 *
 * Live: whether Tailscale is on this phone is asked again whenever the app
 * comes back to the front (someone went to the Tailscale app and back), and
 * the rest follows the store.
 */

import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { openTailscale, tailscaleInstalled } from '../lib/pairing';
import type { CheckAction, ReachCheck } from '../lib/reachChecklist';
import { space } from '../lib/theme';
import { ShowAll } from './ShowAll';
import { Button, Dot, InsetDivider, T, useToneColor } from './ui';

/** Whether Tailscale is on this phone, asked again each time the app comes back. */
export function useTailscaleInstalled(): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const check = () => void tailscaleInstalled().then((v) => live && setInstalled(v));
    check();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && check());
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return installed;
}

const ACTION_TITLE: Record<CheckAction, string> = {
  open_tailscale: 'Open Tailscale',
  get_tailscale: 'Get Tailscale',
  pair_again: 'Pair again',
};

export function ReachChecklist({
  checks,
  detail,
  onPairAgain,
}: {
  checks: ReachCheck[];
  /** The folded line: where it looked. */
  detail?: string;
  onPairAgain?: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const toneColor = useToneColor();
  const [open, setOpen] = useState(false);
  return (
    <View testID="reach-checklist">
      {checks.map((c, i) => {
        const press =
          c.action === 'pair_again'
            ? onPairAgain
            : c.action
              ? () => void openTailscale()
              : undefined;
        return (
          <View key={c.id} style={styles.row} testID={`reach-${c.id}`}>
            <View style={styles.dot}>
              <Dot color={toneColor[c.tone]} />
            </View>
            <View style={styles.body}>
              <T color={colors.textBody}>{c.title}</T>
              <T variant="small" color={colors.textSecondary}>
                {c.status}
              </T>
              {c.fix && (
                <T variant="small" color={colors.textMuted}>
                  {c.fix}
                </T>
              )}
              {c.action && press && (
                <Button
                  title={ACTION_TITLE[c.action]}
                  variant="outline"
                  size="compact"
                  icon={c.action === 'pair_again' ? 'qrcode.viewfinder' : 'network'}
                  onPress={press}
                  style={styles.action}
                />
              )}
            </View>
            {i < checks.length - 1 && <InsetDivider />}
          </View>
        );
      })}
      {detail && (
        <View style={styles.detail}>
          <ShowAll open={open} onPress={() => setOpen((o) => !o)} label="Details" />
          {open && (
            <T variant="small" color={colors.textMuted} style={styles.detailText}>
              {detail}
            </T>
          )}
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  row: { flexDirection: 'row', gap: space.md, paddingVertical: space.md, alignItems: 'flex-start' },
  // Centred on the title's first line: (24 line − 8 dot) / 2.
  dot: { paddingTop: space.sm },
  body: { flex: 1, gap: space['2xs'] },
  action: { alignSelf: 'flex-start', marginTop: space.xs },
  detail: { marginTop: space.xs, marginLeft: -space.md },
  detailText: { paddingHorizontal: space.md },
}));
