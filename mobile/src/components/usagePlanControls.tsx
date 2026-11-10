/**
 * The usage mode and the spare-capacity list, changed from the phone (persona
 * review 2026-11-09, the Maximizer): the mode as one segmented choice, "Add to
 * the spare list", and "Give agents something to do". Only on a Mac that
 * serves `agents.usage.setMode` / `agents.spare.*`; an older Mac's phone keeps
 * the read-only lines and asks the Chief in chat.
 *
 * The phone is the user, so the mode applies at once, as in the desk's
 * Settings (an agent asking for it gets a card). Worded by the protocol's
 * usage.ts, exactly as the desk words it.
 */

import {
  USAGE_MODE_DETAIL,
  USAGE_MODE_LABEL,
  USAGE_MODES,
  type UsageInventory,
  type UsageMode,
} from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { call, canCall, describeError } from '../lib/session';
import { fonts, radius, space, type } from '../lib/theme';
import { Button, Segmented, SectionTitle, T } from './ui';

/** Short labels for the segmented choice; the full name is said under it. */
const SHORT: Record<UsageMode, string> = {
  normal: 'Normal',
  save: 'Save',
  use_it_all: 'Use it all',
};

/** Whether this Mac lets the phone change the mode and the list. */
export function servesUsageChanges(): boolean {
  return canCall('agents.usage.setMode') && canCall('agents.spare.add');
}

export function UsagePlanControls({
  inventory,
  onChanged,
}: {
  inventory: UsageInventory;
  onChanged: (inv: UsageInventory) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'mode' | 'add' | 'spend' | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waiting = inventory.backlog.filter((i) => i.state !== 'started').length;
  const canSpend = canCall('agents.spare.spendNow');

  const run = async (what: 'mode' | 'add' | 'spend', f: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    setError(null);
    setSaid(null);
    try {
      await f();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const setMode = (mode: UsageMode) =>
    mode !== inventory.mode &&
    void run('mode', async () => {
      onChanged(await call('agents.usage.setMode', { mode }));
      haptic.light();
    });

  const add = () => {
    const t = text.trim();
    if (!t) return;
    void run('add', async () => {
      onChanged(await call('agents.spare.add', { text: t }));
      setText('');
      setSaid('Added to the spare-capacity list.');
    });
  };

  const spend = () =>
    void run('spend', async () => {
      const { line } = await call('agents.spare.spendNow', {});
      setSaid(line);
    });

  return (
    <View style={styles.wrap}>
      <SectionTitle title="How agents use your limits" style={styles.title} />
      <Segmented
        value={inventory.mode}
        options={USAGE_MODES.map((m) => ({ value: m, label: SHORT[m] }))}
        onChange={setMode}
      />
      <T variant="small" color={colors.textSecondary}>
        {USAGE_MODE_LABEL[inventory.mode]}: {USAGE_MODE_DETAIL[inventory.mode]}
      </T>

      <SectionTitle title="Spare-capacity list" style={[styles.title, styles.gap]} />
      <T variant="small" color={colors.textMuted}>
        {waiting === 0
          ? 'Nothing waiting. Add work to do when a limit is about to reset with room left.'
          : `${waiting} waiting for spare capacity.`}
      </T>
      <View style={styles.addRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Something to do with spare room"
          placeholderTextColor={colors.textMuted}
          maxLength={600}
          style={styles.input}
          accessibilityLabel="Add to the spare-capacity list"
          returnKeyType="done"
          onSubmitEditing={add}
        />
        <Button
          title="Add"
          size="compact"
          busy={busy === 'add'}
          disabled={!text.trim()}
          onPress={add}
        />
      </View>
      {canSpend && (
        <Button
          title="Give agents something to do"
          busy={busy === 'spend'}
          disabled={waiting === 0}
          onPress={spend}
        />
      )}
      {said && (
        <T variant="small" color={colors.textSecondary}>
          {said}
        </T>
      )}
      {error && (
        <T variant="small" color={colors.accentErrorLight}>
          {error}
        </T>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  wrap: { gap: space.sm, marginBottom: space.xl },
  // Flush with the choice and the lines under it (the wrap's gap spaces it),
  // as the usage page's other group labels sit, not inset as over a card.
  title: { marginLeft: 0, marginBottom: 0 },
  gap: { marginTop: space.md },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  input: {
    flex: 1,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surfaceControl,
    color: colors.textPrimary,
    fontFamily: fonts.regular,
    fontSize: type.body,
  },
}));
