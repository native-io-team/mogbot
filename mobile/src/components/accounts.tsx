/**
 * Settings → Accounts: each engine's accounts, in the order turns try them,
 * with which one is in use, its room, and who is set to run only on it.
 * "Use now" puts one first; the arrows move one earlier or later. Adding
 * an account or signing one in happens on the Mac (`ADD_ON_MAC`).
 *
 * Every row is a Line (docs/agents.md, "Lines, cards and bars"): the name,
 * then muted lines. "In use" is a neutral tick, never the accent: the
 * accent is the Chief's colour, not a status.
 */

import {
  ADD_ACCOUNT_WHY,
  ADD_ON_MAC,
  pinnedLine,
  type SwitcherEngine,
  type SwitcherRow,
} from '@shipstudio/companion-protocol';
import { View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import type { AccountsState } from '../lib/accounts';
import { iconSize, space } from '../lib/theme';
import { Button, Icon, IconButton, InsetDivider, Section, StatusPill, T } from './ui';

/** Its room, after the state pill: "5-hour 62% left, resets 2:07 AM". */
function roomLine(r: SwitcherRow): string {
  return r.room
    .map((l) => `${l.label} ${l.left}% left${l.resets ? `, ${l.resets}` : ''}`)
    .join(' · ');
}

/** The muted lines under an account's name (as read aloud, and in tests). */
export function accountRowLines(r: SwitcherRow): string[] {
  const room = r.room.map((l) => `${l.label} ${l.left}% left${l.resets ? `, ${l.resets}` : ''}`);
  return [
    r.detail.join(' · '),
    [r.state, ...room].join(' · '),
    pinnedLine(r.pinnedBy) ?? '',
  ].filter(Boolean);
}

/** Engines worth a section: one with a sign-in, or more than one account. */
export function shownEngines(view: SwitcherEngine[]): SwitcherEngine[] {
  return view.filter((e) => e.rows.length > 1 || e.rows.some((r) => r.signedIn));
}

export function AccountsSections({ state }: { state: AccountsState }) {
  const colors = useColors();
  const styles = useStyles();
  const engines = shownEngines(state.view);
  if (!state.serves || engines.length === 0) return null;
  const several = engines.length > 1;
  return (
    <>
      {engines.map((e, ei) => (
        <Section
          key={e.engine}
          title={several ? `${e.label} accounts` : 'Accounts'}
          footer={ei === engines.length - 1 ? `${ADD_ACCOUNT_WHY} ${ADD_ON_MAC}` : undefined}
        >
          {e.rows.map((r, i) => (
            <AccountLine
              key={r.key}
              row={r}
              index={i}
              count={e.rows.length}
              state={state}
              last={i === e.rows.length - 1}
            />
          ))}
        </Section>
      ))}
      {state.error && (
        <T variant="small" color={colors.accentErrorLight} style={styles.error}>
          {state.error}
        </T>
      )}
    </>
  );
}

/**
 * One account: its name over muted lines, the full width, and under them
 * what can be done (Use now, earlier, later), so neither squeezes the other.
 */
function AccountLine({
  row: r,
  index: i,
  count,
  state,
  last,
}: {
  row: SwitcherRow;
  index: number;
  count: number;
  state: AccountsState;
  last: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  const use = r.canUse && state.canSwap;
  const order = state.canReorder && count > 1;
  return (
    <View style={styles.row} accessibilityLabel={`${r.name}. ${accountRowLines(r).join('. ')}`}>
      <View style={styles.lead}>
        {r.inUse && <Icon name="checkmark" size={iconSize.body} color={colors.textStrong} />}
      </View>
      <View style={styles.body}>
        <T color={colors.textBody}>{r.name}</T>
        {r.detail.length > 0 && (
          <T variant="small" color={colors.textMuted}>
            {r.detail.join(' · ')}
          </T>
        )}
        {/* Its state as a pill (out of usage, in use, signed in or not), its room after it. */}
        <View style={styles.state}>
          {!!r.state && (
            <StatusPill
              tone={r.tone === 'out' ? 'out' : r.inUse && r.tone === 'ok' ? 'done' : 'idle'}
              label={r.state}
            />
          )}
          {roomLine(r) !== '' && (
            <T variant="small" color={colors.textMuted} style={styles.stateRest}>
              {roomLine(r)}
            </T>
          )}
        </View>
        {!!pinnedLine(r.pinnedBy) && (
          <T variant="small" color={colors.textMuted}>
            {pinnedLine(r.pinnedBy)}
          </T>
        )}
        {(use || order) && (
          <View style={styles.actions}>
            {use && (
              <Button
                title="Use now"
                size="compact"
                variant="secondary"
                disabled={state.busy}
                accessibilityLabel={`Use ${r.name} now`}
                onPress={() => void state.swapTo(r.engine, r.id)}
              />
            )}
            <View style={styles.spacer} />
            {order && (
              <View style={styles.order}>
                {i > 0 ? (
                  <IconButton
                    name="arrow.up"
                    size={iconSize.body}
                    label={`Try ${r.name} earlier`}
                    disabled={state.busy}
                    onPress={() => void state.move(r.engine, i, -1)}
                  />
                ) : (
                  <View style={styles.slot} />
                )}
                {i < count - 1 ? (
                  <IconButton
                    name="arrow.down"
                    size={iconSize.body}
                    label={`Try ${r.name} later`}
                    disabled={state.busy}
                    onPress={() => void state.move(r.engine, i, 1)}
                  />
                ) : (
                  <View style={styles.slot} />
                )}
              </View>
            )}
          </View>
        )}
      </View>
      {!last && <InsetDivider />}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  lead: { width: iconSize.body, paddingTop: space['2xs'] },
  body: { flex: 1, gap: space['2xs'] },
  state: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.xs },
  stateRest: { flexShrink: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: space.xs },
  spacer: { flex: 1 },
  order: { flexDirection: 'row', alignItems: 'center' },
  // An arrow that isn't there keeps its 44pt place, so the rows line up.
  slot: { width: 44 },
  error: { marginHorizontal: space.lg, marginTop: -space.md, marginBottom: space.lg },
}));
