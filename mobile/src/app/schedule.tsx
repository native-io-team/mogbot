/**
 * Add or edit a check-in or routine with a picker, not a grammar: When is a
 * few chips and a time, What is one line. Above Save it says back what it
 * will make ("Every weekday at 9:00 AM — Draft my day"), and the Mac's own
 * parser confirms the first run, so what you save is what it will do.
 *
 * The picker writes the same `when` words the desk's one-line composer
 * takes (`routineWhenPhrase`), so a phone-made routine is a desk-made one.
 *
 * Times are the Mac's: it reads the words on its own clock, so the picker
 * works in `welcome.timeZone` and says "Mac time" when that isn't the
 * phone's. An edit that leaves the When alone sends no `when`, so the
 * schedule stays exactly as it was (on a Mac that reports its zone).
 */

import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import {
  describeRun,
  formatWhen,
  formatWhenIn,
  routineEcho,
  routineInPast,
  routineWhenOf,
  routineWhenPhrase,
  zoneDiffers,
  type CheckInRun,
  type MonthDay,
  type SchedulePreview,
} from '@shipstudio/companion-protocol';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useNow } from '../components/ConnectionPill';
import { Chip, ChipRow } from '../components/pickers';
import { choose } from '../components/menu';
import { Button, T, SheetPage } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { describeError, schedule } from '../lib/session';
import { useApp } from '../lib/store';
import { WireFailure } from '../lib/transport';
import { useAccent } from '../lib/accent';
import { withAgentAccent } from '../lib/accentScreen';
import {
  CADENCES,
  INTERVALS,
  intervalLabel,
  MONTH_INTERVALS,
  MONTH_KINDS,
  monthKindOf,
  monthsLabel,
  monthWhichChoices,
  monthWhichOf,
  newPicker,
  onceDays,
  pickerOf,
  setMonthKind,
  setMonthWhich,
  toggleDay,
  WEEK,
  whenOf,
  type PickerState,
} from '../lib/routine';
import { chromeScale, fonts, lineHeight, radius, space, type } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';

type Reading =
  | { kind: 'reading' }
  | { kind: 'ok'; preview: SchedulePreview }
  | { kind: 'bad'; reason: string };

/** The Mac's reading: "First run tomorrow 9:00 AM", on the clock the echo uses. */
function firstRun(p: SchedulePreview, now = Date.now(), timeZone?: string): string {
  const when = formatWhenIn(p.nextAt, now, timeZone).replace(/^(Today|Tomorrow)/, (w) =>
    w.toLowerCase()
  );
  const zone = zoneDiffers(timeZone, now) ? ' Mac time' : '';
  return p.repeat ? `First run ${when}${zone}` : `Runs ${when}${zone}`;
}

export default withAgentAccent(Schedule, 'agentId');

function Schedule() {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const router = useRouter();
  const now = useNow(30_000);
  const { agentId, id } = useLocalSearchParams<{ agentId: string; id?: string }>();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === agentId));
  const editing = agent?.checkIns?.find((c) => c.id === id);
  // The Mac's zone, and whether it keeps a schedule when an edit sends no `when`.
  const timeZone = useApp((s) => s.welcome?.timeZone);
  const [picker, setPicker] = useState<PickerState>(() =>
    editing
      ? pickerOf(routineWhenOf(editing, timeZone), Date.now(), timeZone)
      : newPicker(Date.now(), timeZone)
  );
  // What the When said when the sheet opened: unchanged, it isn't re-sent.
  const [openedAs] = useState(() =>
    editing ? routineWhenPhrase(routineWhenOf(editing, timeZone)) : null
  );
  const [note, setNote] = useState(() => editing?.note ?? '');
  const [answer, setAnswer] = useState<{ phrase: string; reading: Reading } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (patch: Partial<PickerState>) => setPicker((p) => ({ ...p, ...patch }));

  const when = whenOf(picker);
  const phrase = when ? routineWhenPhrase(when) : '';
  const past = when ? routineInPast(when, now, timeZone) : false;
  const macClock = zoneDiffers(timeZone, now);
  // The editing check-in's own date and interval stay offered even if off the usual chips.
  const [keepDate] = useState(() => (editing && !editing.repeat ? picker.date : undefined));
  const days = useMemo(() => onceDays(now, keepDate, timeZone), [now, keepDate, timeZone]);
  const intervals = useMemo(
    () => (INTERVALS.includes(picker.minutes) ? INTERVALS : [...INTERVALS, picker.minutes]),
    // Only the opening value adds a chip; tapping the offered ones doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const monthIntervals = useMemo(
    () =>
      MONTH_INTERVALS.includes(picker.months)
        ? MONTH_INTERVALS
        : [...MONTH_INTERVALS, picker.months],
    // As above: only the opening value adds a chip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // The Mac reads the phrase back: the first run, or why it can't.
  useEffect(() => {
    if (!phrase || past) return;
    let live = true;
    const timer = setTimeout(() => {
      schedule.preview(phrase).then(
        (preview) => live && setAnswer({ phrase, reading: { kind: 'ok', preview } }),
        (e: unknown) =>
          live &&
          setAnswer({
            phrase,
            reading: {
              kind: 'bad',
              reason:
                e instanceof WireFailure && e.error.type === 'Validation'
                  ? e.error.reason
                  : describeError(e),
            },
          })
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [phrase, past]);

  const reading: Reading = past
    ? { kind: 'bad', reason: 'That time has passed. Pick a later one.' }
    : answer?.phrase === phrase
      ? answer.reading
      : { kind: 'reading' };

  const save = async () => {
    if (!phrase) return;
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        // Left as it was: no `when`, so "every 2 hours" isn't re-anchored to now.
        const keep = phrase === openedAs && timeZone !== undefined;
        await schedule.update(agentId, editing.id, keep ? '' : phrase, note.trim());
      } else await schedule.create(agentId, phrase, note.trim());
      router.back();
    } catch (e) {
      setError(describeError(e));
      setSaving(false);
    }
  };

  const ready = reading.kind === 'ok' && note.trim().length > 0 && !saving;
  const timed = picker.cadence !== 'hours';
  // A routine, whether it runs once or repeats: one word for one thing.
  const title = editing ? 'Edit routine' : agent ? `New routine for ${agent.name}` : 'New routine';

  return (
    <SheetPage>
      <ScrollView
        contentContainerStyle={styles.root}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <SheetTitle>{title}</SheetTitle>

        <View style={styles.group}>
          <T variant="caption" color={colors.textMuted} style={styles.label}>
            WHEN
          </T>
          <ChipRow label="How often">
            {CADENCES.map((c) => (
              <Chip
                key={c.value}
                label={c.label}
                selected={picker.cadence === c.value}
                onPress={() => change({ cadence: c.value })}
              />
            ))}
          </ChipRow>
          {picker.cadence === 'weekly' && (
            <Animated.View entering={FadeIn.duration(150)}>
              <ChipRow label="On these days" multiple>
                {WEEK.map((d) => (
                  <Chip
                    key={d.day}
                    role="checkbox"
                    label={d.short}
                    accessibilityLabel={d.name}
                    selected={picker.days.includes(d.day)}
                    onPress={() => change({ days: toggleDay(picker.days, d.day) })}
                  />
                ))}
              </ChipRow>
            </Animated.View>
          )}
          {picker.cadence === 'monthly' && (
            <Animated.View entering={FadeIn.duration(150)} style={styles.group}>
              <ChipRow label="How many months">
                {monthIntervals.map((m) => (
                  <Chip
                    key={m}
                    label={monthsLabel(m)}
                    selected={picker.months === m}
                    onPress={() => change({ months: m })}
                  />
                ))}
              </ChipRow>
              <MonthDayRow on={picker.monthDay} onChange={(monthDay) => change({ monthDay })} />
            </Animated.View>
          )}
          {picker.cadence === 'hours' && (
            <Animated.View entering={FadeIn.duration(150)}>
              <ChipRow label="Every">
                {intervals.map((m) => (
                  <Chip
                    key={m}
                    label={intervalLabel(m)}
                    selected={picker.minutes === m}
                    onPress={() => change({ minutes: m })}
                  />
                ))}
              </ChipRow>
            </Animated.View>
          )}
          {picker.cadence === 'once' && (
            <Animated.View entering={FadeIn.duration(150)}>
              <ChipRow label="On">
                {days.map((d) => (
                  <Chip
                    key={d.date}
                    label={d.label}
                    selected={picker.date === d.date}
                    onPress={() => change({ date: d.date })}
                  />
                ))}
              </ChipRow>
            </Animated.View>
          )}
          {timed && (
            <TimeRow
              hour={picker.hour}
              minute={picker.minute}
              onChange={(hour, minute) => change({ hour, minute })}
              macClock={macClock}
              themeVariant={appearance}
              tint={accent.accent}
            />
          )}
        </View>

        <View style={styles.group}>
          <T variant="caption" color={colors.textMuted} style={styles.label} nativeID="what-label">
            WHAT
          </T>
          <TextInput
            value={note}
            onChangeText={(t) => setNote(t.replace(/\n/g, ' '))}
            placeholder="Draft my day"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            selectionColor={accent.accent}
            keyboardAppearance={appearance}
            returnKeyType="done"
            multiline
            submitBehavior="blurAndSubmit"
            onSubmitEditing={() => ready && void save()}
            accessibilityLabel={`What ${agent?.name ?? 'the agent'} should do`}
            accessibilityLabelledBy="what-label"
          />
        </View>

        <View style={styles.echo} accessibilityLiveRegion="polite">
          {when && (
            <T variant="subhead" color={colors.textStrong} maxFontSizeMultiplier={2}>
              {routineEcho(when, note, now, timeZone)}
            </T>
          )}
          {reading.kind === 'ok' ? (
            <Animated.View entering={FadeIn.duration(150)}>
              <T variant="caption" color={colors.textSecondary}>
                {firstRun(reading.preview, now, timeZone)}
                {!note.trim() && ` · now say what ${agent?.name ?? 'it'} should do`}
              </T>
            </Animated.View>
          ) : reading.kind === 'bad' ? (
            <T variant="small" color={colors.accentErrorLight}>
              {reading.reason}
            </T>
          ) : (
            <T variant="caption" color={colors.textMuted}>
              Checking with the Mac…
            </T>
          )}
        </View>
        {error && (
          <T variant="small" color={colors.accentErrorLight}>
            {error}
          </T>
        )}
        <View style={styles.actions}>
          <Button
            title="Cancel"
            variant="ghost"
            onPress={() => router.back()}
            style={{ flex: 1 }}
          />
          <Button
            title={editing ? 'Save' : 'Schedule'}
            variant="primary"
            disabled={!ready}
            busy={saving}
            onPress={() => void save()}
            style={{ flex: 1 }}
          />
        </View>
        {!!editing?.runs?.length && <RunHistory runs={editing.runs} />}
      </ScrollView>
    </SheetPage>
  );
}

/**
 * "At" and the platform's own time picker: iOS's compact wheel-in-a-popover,
 * Android's clock dialog behind a button. Both follow the app's appearance.
 */
function TimeRow({
  hour,
  minute,
  onChange,
  macClock,
  themeVariant,
  tint,
}: {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  /** The Mac's clock isn't the phone's: the time is its. */
  macClock: boolean;
  themeVariant: 'light' | 'dark';
  tint: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  const value = useMemo(() => new Date(2000, 0, 1, hour, minute), [hour, minute]);
  const picked = (_: DateTimePickerEvent, date?: Date) => {
    if (date) onChange(date.getHours(), date.getMinutes());
  };
  const clock = formatWhen(value.getTime(), value.getTime()).replace(/^Today /, '');
  return (
    <View style={styles.timeRow}>
      <T variant="subhead" color={colors.textPrimary} maxFontSizeMultiplier={chromeScale}>
        {macClock ? 'At, Mac time' : 'At'}
      </T>
      {Platform.OS === 'ios' ? (
        <DateTimePicker
          value={value}
          mode="time"
          display="compact"
          minuteInterval={5}
          onChange={picked}
          themeVariant={themeVariant}
          accentColor={tint}
          accessibilityLabel={`Time, ${clock}${macClock ? ' Mac time' : ''}`}
        />
      ) : (
        <Button
          title={clock}
          size="compact"
          onPress={() =>
            DateTimePickerAndroid.open({ value, mode: 'time', onChange: picked, is24Hour: false })
          }
          accessibilityLabel={`Time, ${clock}${macClock ? ' Mac time' : ''}. Change`}
        />
      )}
    </View>
  );
}

/**
 * Which day of the month, as the desk says it: "On the [15th] [day]", "On
 * the [last] [Friday]". Each part opens the system's list of choices.
 */
function MonthDayRow({ on, onChange }: { on: MonthDay; onChange: (on: MonthDay) => void }) {
  const colors = useColors();
  const styles = useStyles();
  const kind = monthKindOf(on);
  const choices = monthWhichChoices(kind);
  const which = choices.find((c) => c.value === monthWhichOf(on))?.label ?? '';
  const of = MONTH_KINDS.find((k) => k.value === kind)?.label ?? '';
  return (
    <View style={styles.timeRow}>
      <T variant="subhead" color={colors.textPrimary} maxFontSizeMultiplier={chromeScale}>
        On the
      </T>
      <View style={styles.monthParts}>
        <Button
          title={which}
          size="compact"
          onPress={() =>
            choose(
              'On the',
              choices.map((c) => ({
                label: c.label,
                run: () => onChange(setMonthWhich(on, c.value)),
              }))
            )
          }
          accessibilityLabel={`Which, ${which}. Change`}
        />
        <Button
          title={of}
          size="compact"
          onPress={() =>
            choose(
              `On the ${which}`,
              MONTH_KINDS.map((k) => ({
                label: k.value === 'day' ? 'day of the month' : k.label,
                run: () => onChange(setMonthKind(on, k.value)),
              }))
            )
          }
          accessibilityLabel={`${kind === 'day' ? 'Day of the month' : of}. Change`}
        />
      </View>
    </View>
  );
}

/** Its last runs, newest first: when, and what came of it, in the desk's words. */
function RunHistory({ runs }: { runs: CheckInRun[] }) {
  const colors = useColors();
  const styles = useStyles();
  const now = useNow(30_000);
  return (
    <View style={{ gap: space.xs, marginTop: space.sm }}>
      <T variant="caption" color={colors.textMuted} style={styles.heading}>
        PAST RUNS
      </T>
      <View style={styles.list} accessibilityLabel="Past runs">
        {[...runs].reverse().map((run, i) => {
          const outcome = [
            describeRun(run, now),
            run.manual ? 'run now' : null,
            run.detail ?? null,
            run.signIn?.length ? `${run.signIn.join(', ')} needs signing in again` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          const failed = run.outcome === 'failed' || run.outcome === 'retrying';
          return (
            <View key={`${run.at}-${run.attempt}`} style={[styles.run, i > 0 && styles.divider]}>
              <T variant="small" color={colors.textPrimary}>
                {formatWhen(run.at, now)}
              </T>
              <T
                variant="caption"
                color={failed ? colors.accentErrorLight : colors.textSecondary}
                numberOfLines={3}
              >
                {outcome}
              </T>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { padding: space.lg, paddingTop: space.xl, gap: space.lg, paddingBottom: space['2xl'] },
  group: { gap: space.sm },
  label: { letterSpacing: 0.4 },
  input: {
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.35),
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    minHeight: 48,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingLeft: space.md,
    paddingRight: space.xs,
    borderRadius: radius.inner,
    backgroundColor: colors.surfaceGroup,
  },
  monthParts: { flexDirection: 'row', gap: space.xs },
  echo: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceGroup,
    minHeight: 64,
    overflow: 'hidden',
  },
  actions: { flexDirection: 'row', gap: space.sm },
  heading: { marginLeft: space.lg, letterSpacing: 0.4 },
  list: { backgroundColor: colors.surfaceGroup, borderRadius: radius.card, overflow: 'hidden' },
  run: { paddingHorizontal: space.lg, paddingVertical: space.sm + 2, gap: space['2xs'] },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDefault },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
