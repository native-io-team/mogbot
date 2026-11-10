/**
 * The blocks that ask: quick-reply choices, a comparison's "Pick this", and
 * a short form. Each answer is the user's own message (`Answering.reply`):
 * neutral buttons, never the agent's colour. Once the chat has an answer
 * after the message, they hold still and show which one it was.
 */

import {
  badNumbers,
  formReply,
  missingFields,
  pickedReply,
  type ChoicesBlock,
  type ComparisonBlock,
  type FormBlock,
  type FormField,
  type FormValues,
} from '@shipstudio/companion-protocol';
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { makeStyles, useAppearance, useColors } from '../../lib/appearance';
import {
  CHIP_H,
  fonts,
  iconSize,
  lineHeight,
  PRESSED,
  radius,
  space,
  tapSlop,
  type,
} from '../../lib/theme';
import { Button, Icon, T } from '../ui';

/** Whether and how this block may answer. */
export interface Answering {
  /** Taps send (or stage): the chat is the agent's own, and nothing has answered yet. */
  live: boolean;
  /** What the user said after the message, if anything. */
  answer: string | null;
  reply: (text: string) => void;
}

/* ---- Choices ------------------------------------------------------------------- */

export function BlockChoices({ block, answering }: { block: ChoicesBlock; answering: Answering }) {
  const colors = useColors();
  const styles = useStyles();
  const picked = pickedReply(
    block.options.map((o) => o.reply),
    answering.answer
  );
  return (
    <View style={styles.ask}>
      {!!block.question && (
        <T variant="body" color={colors.textBody}>
          {block.question}
        </T>
      )}
      <View style={styles.choices} accessibilityRole="radiogroup">
        {block.options.map((o, i) => {
          const on = i === picked;
          return (
            <Button
              key={o.label + i}
              title={o.label}
              variant={on ? 'answer' : 'outline'}
              size="compact"
              lines={2}
              icon={on ? 'checkmark' : undefined}
              disabled={!answering.live && !on}
              accessibilityState={{ selected: on, disabled: !answering.live }}
              onPress={answering.live ? () => answering.reply(o.reply) : undefined}
              testID="block-choice"
            />
          );
        })}
      </View>
    </View>
  );
}

/* ---- Comparison ---------------------------------------------------------------- */

export function BlockComparison({
  block,
  answering,
}: {
  block: ComparisonBlock;
  answering: Answering;
}) {
  const colors = useColors();
  const styles = useStyles();
  const picked = pickedReply(
    block.options.map((o) => o.reply),
    answering.answer
  );
  return (
    <View style={styles.options}>
      {block.options.map((o, i) => {
        const on = i === picked;
        return (
          <View
            key={o.name + i}
            style={[styles.option, on && styles.optionOn]}
            testID="comparison-option"
          >
            <View style={styles.optionHead}>
              <T variant="title" color={colors.textStrong} style={styles.flex}>
                {o.name}
              </T>
              {o.recommended && (
                <View style={styles.tag}>
                  <T
                    variant="caption"
                    color={colors.textPrimary}
                    style={{ fontFamily: fonts.medium }}
                  >
                    Recommended
                  </T>
                </View>
              )}
            </View>
            {!!o.summary && (
              <T variant="small" color={colors.textSecondary}>
                {o.summary}
              </T>
            )}
            {!!o.facts?.length && (
              <View style={styles.optionFacts}>
                {o.facts.map((f, k) => (
                  <View key={f.label + k} style={styles.optionFact}>
                    <T variant="caption" color={colors.textMuted}>
                      {f.label}
                    </T>
                    <T variant="subhead" color={colors.textStrong}>
                      {f.value}
                    </T>
                  </View>
                ))}
              </View>
            )}
            {o.pros.map((p, k) => (
              <View key={`p${k}`} style={styles.point} accessible accessibilityLabel={`Pro: ${p}`}>
                <View style={styles.pointIcon}>
                  <Icon name="checkmark" size={iconSize.inline} color={colors.accentSuccess} />
                </View>
                <T variant="small" color={colors.textPrimary} style={styles.flex}>
                  {p}
                </T>
              </View>
            ))}
            {o.cons.map((c, k) => (
              <View key={`c${k}`} style={styles.point} accessible accessibilityLabel={`Con: ${c}`}>
                <View style={styles.pointIcon}>
                  <Icon name="minus.circle" size={iconSize.inline} color={colors.textMuted} />
                </View>
                <T variant="small" color={colors.textSecondary} style={styles.flex}>
                  {c}
                </T>
              </View>
            ))}
            {on ? (
              <View style={styles.picked} testID="comparison-picked">
                <Icon name="checkmark" size={iconSize.inline} color={colors.textStrong} />
                <T variant="subhead" color={colors.textStrong}>
                  Picked
                </T>
              </View>
            ) : answering.live ? (
              <Button
                title="Pick this"
                variant={o.recommended ? 'answer' : 'outline'}
                accessibilityLabel={`Pick ${o.name}`}
                onPress={() => answering.reply(o.reply)}
                style={styles.pick}
                testID="comparison-pick"
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/* ---- Form ---------------------------------------------------------------------- */

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const dayOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
};

export function BlockForm({ block, answering }: { block: FormBlock; answering: Answering }) {
  const colors = useColors();
  const styles = useStyles();
  const [values, setValues] = useState<FormValues>({});
  const [tried, setTried] = useState(false);
  const missing = missingFields(block, values);
  const bad = badNumbers(block, values);
  const wrong = new Set([...missing, ...bad]);
  const set = (id: string, v: string) => setValues((s) => ({ ...s, [id]: v }));
  const submit = () => {
    setTried(true);
    if (wrong.size) return;
    answering.reply(formReply(block, values));
  };
  const answered = answering.answer != null;
  return (
    <View style={styles.form}>
      {block.fields.map((f) => (
        <Field
          key={f.id}
          field={f}
          value={values[f.id] ?? ''}
          onChange={(v) => set(f.id, v)}
          editable={answering.live}
          error={
            tried && wrong.has(f.id)
              ? bad.includes(f.id)
                ? 'A number, please'
                : 'Needed'
              : undefined
          }
        />
      ))}
      {tried && wrong.size > 0 && (
        <T variant="small" color={colors.accentErrorLight} accessibilityLiveRegion="polite">
          {missing.length
            ? `Fill in ${block.fields
                .filter((f) => missing.includes(f.id))
                .map((f) => f.label)
                .join(', ')} first.`
            : 'Check the numbers.'}
        </T>
      )}
      {answered ? (
        <View style={styles.sent}>
          <Icon name="checkmark" size={iconSize.inline} color={colors.textMuted} />
          <T variant="small" color={colors.textMuted}>
            Sent
          </T>
        </View>
      ) : (
        <Button
          title={block.submit}
          variant="answer"
          disabled={!answering.live}
          onPress={submit}
          style={styles.submit}
          testID="form-submit"
        />
      )}
    </View>
  );
}

function Field({
  field,
  value,
  onChange,
  editable,
  error,
}: {
  field: FormField;
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
  error?: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const label = `${field.label}${field.required ? '' : ' (optional)'}`;
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <T variant="small" color={colors.textSecondary} style={{ fontFamily: fonts.medium }}>
          {field.label}
        </T>
        {!field.required && (
          <T variant="caption" color={colors.textMuted}>
            Optional
          </T>
        )}
        {!!error && (
          <T variant="caption" color={colors.accentErrorLight} style={styles.fieldError}>
            {error}
          </T>
        )}
      </View>
      {field.type === 'choice' ? (
        <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={label}>
          {(field.options ?? []).map((o) => {
            const on = value === o;
            return (
              <Pressable
                key={o}
                accessibilityRole="radio"
                accessibilityState={{ selected: on, disabled: !editable }}
                hitSlop={tapSlop(CHIP_H)}
                disabled={!editable}
                onPress={() => onChange(on ? '' : o)}
                style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && PRESSED]}
                testID="form-chip"
              >
                <T
                  variant="small"
                  color={on ? colors.onSelectedFill : colors.textPrimary}
                  style={on ? { fontFamily: fonts.medium } : undefined}
                >
                  {o}
                </T>
              </Pressable>
            );
          })}
        </View>
      ) : field.type === 'date' ? (
        <DateField
          value={value}
          onChange={onChange}
          editable={editable}
          label={label}
          placeholder={field.placeholder}
        />
      ) : (
        <TextInput
          value={value}
          onChangeText={onChange}
          editable={editable}
          accessibilityLabel={label}
          placeholder={field.placeholder}
          placeholderTextColor={colors.textMuted}
          keyboardType={field.type === 'number' ? 'decimal-pad' : 'default'}
          multiline={field.type === 'long_text'}
          keyboardAppearance={appearance}
          style={[
            styles.input,
            field.type === 'long_text' && styles.inputLong,
            !!error && { borderColor: colors.accentErrorLight },
            !editable && styles.inputOff,
          ]}
          testID={`form-field-${field.id}`}
        />
      )}
    </View>
  );
}

function DateField({
  value,
  onChange,
  editable,
  label,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
  label: string;
  placeholder?: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const picked = (_: DateTimePickerEvent, date?: Date) => {
    if (date) onChange(isoDay(date));
  };
  const shown = value
    ? dayOf(value)
        .toDateString()
        .replace(/^(\w{3}) (\w{3}) 0?(\d+) (\d{4})$/, '$1, $3 $2 $4')
    : (placeholder ?? 'Choose a date');
  if (Platform.OS === 'ios' && value) {
    return (
      <DateTimePicker
        value={dayOf(value)}
        mode="date"
        display="compact"
        onChange={picked}
        disabled={!editable}
        themeVariant={appearance}
        accessibilityLabel={`${label}, ${shown}`}
        style={styles.datePicker}
      />
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value ? shown : 'not chosen'}`}
      disabled={!editable}
      onPress={() => {
        const now = value ? dayOf(value) : new Date();
        if (Platform.OS === 'android')
          DateTimePickerAndroid.open({ value: now, mode: 'date', onChange: picked });
        else onChange(isoDay(now));
      }}
      style={({ pressed }) => [
        styles.input,
        styles.dateButton,
        !editable && styles.inputOff,
        pressed && PRESSED,
      ]}
      testID="form-date"
    >
      <Icon name="calendar" size={iconSize.body} color={colors.textMuted} />
      <T variant="body" color={value ? colors.textBody : colors.textMuted}>
        {shown}
      </T>
    </Pressable>
  );
}

const useStyles = makeStyles((colors) => ({
  flex: { flex: 1 },
  ask: { gap: space.sm },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  options: { gap: space.sm },
  option: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.inner,
    backgroundColor: colors.surfaceApp,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  optionOn: { borderColor: colors.borderStrong },
  optionHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  tag: {
    paddingHorizontal: space.sm,
    paddingVertical: space['2xs'],
    borderRadius: radius.tag,
    backgroundColor: colors.surfaceControl,
  },
  optionFacts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.lg, rowGap: space.xs },
  optionFact: { gap: space['2xs'] },
  point: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  pointIcon: { height: lineHeight(type.small), justifyContent: 'center' },
  picked: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    minHeight: 44,
    marginTop: space.xs,
  },
  pick: { marginTop: space.xs },
  form: { gap: space.md },
  field: { gap: space.xs },
  fieldHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  fieldError: { marginLeft: 'auto' },
  input: {
    minHeight: 44,
    fontFamily: fonts.regular,
    fontSize: type.body,
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.inputBorder,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  inputLong: { minHeight: 88, textAlignVertical: 'top' },
  inputOff: { opacity: 0.7 },
  dateButton: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  datePicker: { alignSelf: 'flex-start' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: CHIP_H,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.borderStrong,
  },
  chipOn: { backgroundColor: colors.selectedFill, borderColor: colors.selectedFill },
  sent: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-end' },
  submit: { alignSelf: 'flex-end' },
}));
