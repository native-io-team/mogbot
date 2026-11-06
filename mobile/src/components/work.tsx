/**
 * What a turn did, as on the desktop (`AgentWork.tsx`): under the message it
 * ended on, one quiet line that opens into the steps; while the agent works,
 * a folded "8 steps so far" under the working row that opens into the
 * steps so far. Only what the Mac recorded; a message without `work` (or
 * from an older Mac) shows nothing.
 */

import type { AgentMessage, LiveCall, TurnWork, WorkStep } from '@shipstudio/companion-protocol';
import {
  formatElapsed,
  lifeLine,
  offersStopStep,
  outputNote,
  quietLine,
  slowHint,
  stepLine,
} from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { call, describeError, stop } from '../lib/session';
import { useServed } from '../lib/store';
import { fonts, iconSize, radius, space, PRESSED } from '../lib/theme';
import {
  earlierSteps,
  liveSteps,
  liveSummary,
  stepOffset,
  stepOffsetSpoken,
  stepSymbol,
  workSummary,
} from '../lib/work';
import { Attachments } from './attachments';
import { TypingDots } from './TypingDots';
import { Button, Icon, T } from './ui';

/** The chevron and its words: the same control folded and open. */
function Toggle({
  open,
  label,
  onPress,
  hint = open ? 'Hides the steps' : 'Shows each step',
}: {
  open: boolean;
  label: string;
  onPress: () => void;
  hint?: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      onPress={() => {
        haptic.select();
        onPress();
      }}
      // A caption line is 16pt tall: the slop makes it a 44pt target.
      hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ expanded: open }}
      style={({ pressed }) => [styles.head, pressed && PRESSED]}
    >
      <Icon
        name={open ? 'chevron.down' : 'chevron.right'}
        size={iconSize.inline}
        color={colors.textMuted}
      />
      <T variant="caption" color={colors.textMuted} style={styles.count}>
        {label}
      </T>
    </Pressable>
  );
}

function StepRow({
  step,
  startedAt,
  agentId,
  onError,
}: {
  step: WorkStep;
  startedAt: number;
  agentId: string;
  onError: (text: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  // Declined or failed: the label says so in words, and it reads quieter.
  // A note is the agent's own progress line, kept here rather than in the chat: quiet too.
  const note = step.kind === 'note';
  const quiet = step.outcome != null || note;
  // "Ran the Cypress tests · 6m 12s · 42 passed, 3 failed": how long, and what it came to.
  const line = stepLine(step);
  const [showOutput, setShowOutput] = useState(false);
  return (
    <View style={styles.stepBlock} testID={`work-step-${step.kind}`}>
      {/* One stop for VoiceOver: what it did and when, not a glyph, a label and four digits. */}
      <View
        style={styles.step}
        accessible
        accessibilityLabel={`${line}, ${stepOffsetSpoken(step, startedAt)}`}
      >
        <View style={styles.icon}>
          <Icon name={stepSymbol(step.kind)} size={iconSize.inline} color={colors.textMuted} />
        </View>
        <T
          variant="caption"
          color={quiet ? colors.textMuted : colors.textSecondary}
          numberOfLines={2}
          style={[styles.label, note && styles.note]}
        >
          {line}
        </T>
        <T variant="caption" color={colors.textMuted} style={styles.count}>
          {stepOffset(step, startedAt)}
        </T>
      </View>
      {!!step.output?.length && (
        <View style={styles.indent}>
          <Toggle
            open={showOutput}
            label={showOutput ? 'Hide output' : 'Show output'}
            hint={showOutput ? 'Hides what it printed' : 'Shows the last lines it printed'}
            onPress={() => setShowOutput((o) => !o)}
          />
          {showOutput && <Output lines={step.output} />}
        </View>
      )}
      {step.image && (
        <View style={styles.indent}>
          <Attachments agentId={agentId} attachments={[step.image]} onError={onError} />
        </View>
      )}
    </View>
  );
}

function Steps({
  work,
  steps,
  agentId,
  onError,
  files,
}: {
  work: TurnWork;
  steps: WorkStep[];
  agentId: string;
  onError: (text: string) => void;
  files: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  // Not kept by the Mac; the step the working row is saying isn't earlier.
  const earlier = earlierSteps(work);
  const names = files ? (work.files ?? []) : [];
  return (
    <Animated.View entering={FadeIn.duration(180)} style={styles.steps}>
      {earlier > 0 && (
        <T variant="caption" color={colors.textMuted} style={styles.indent}>
          {earlier === 1 ? '1 earlier step' : `${earlier} earlier steps`}
        </T>
      )}
      {steps.map((step, i) => (
        <StepRow
          key={`${step.at}-${i}`}
          step={step}
          startedAt={work.startedAt}
          agentId={agentId}
          onError={onError}
        />
      ))}
      {names.length > 0 && (
        <T variant="caption" color={colors.textMuted} style={styles.indent}>
          Edited {names.join(', ')}
          {work.fileCount > names.length ? ` and ${work.fileCount - names.length} more` : ''}
        </T>
      )}
    </Animated.View>
  );
}

/** Under a finished turn's last message. */
export function WorkLine({
  message,
  work,
  onError,
}: {
  message: AgentMessage;
  work: TurnWork;
  onError: (text: string) => void;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  if (work.stepCount === 0) return null;
  return (
    <View style={styles.wrap}>
      <Toggle open={open} label={workSummary(work)} onPress={() => setOpen((o) => !o)} />
      {open && (
        <Steps work={work} steps={work.steps} agentId={message.agentId} onError={onError} files />
      )}
    </View>
  );
}

/**
 * Under the working row while it works: "8 steps so far", folded, opening
 * into the steps so far. The newest is left out while the working row is
 * saying it (`liveSteps`), so nothing shows twice.
 */
export function LiveWork({
  agentId,
  work,
  activity,
  onError,
}: {
  agentId: string;
  work: TurnWork | undefined;
  activity: string | null;
  onError: (text: string) => void;
}) {
  const styles = useStyles();
  // Open belongs to this turn: the next one starts folded.
  const [openAt, setOpenAt] = useState<number | null>(null);
  if (!work || work.stepCount === 0) return null;
  const open = openAt === work.startedAt;
  return (
    <View style={styles.wrap}>
      <Toggle
        open={open}
        label={liveSummary(work)}
        onPress={() => setOpenAt(open ? null : work.startedAt)}
      />
      {open && (
        <Steps
          work={work}
          steps={liveSteps(work, activity)}
          agentId={agentId}
          onError={onError}
          files={false}
        />
      )}
    </View>
  );
}

/** What a command printed, last lines last, in the terminal's face. */
function Output({ lines }: { lines: string[] }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.output} testID="work-output">
      {lines.map((l, i) => (
        <T
          key={i}
          variant="caption"
          color={colors.textSecondary}
          numberOfLines={1}
          style={styles.mono}
          selectable
        >
          {l}
        </T>
      ))}
    </View>
  );
}

/**
 * The working row's line while a call runs: what it's doing in plain words
 * and for how long ("Running the Cypress tests · 5:32"), then, only when
 * there's something to say, a quiet hint for a known slow tool, "Show
 * output", and after ten minutes "Stop this step". Tapping the line says
 * when it last showed life. Once the Mac says it has made no progress for
 * a while, the line says that instead, with "Check on it" and "Stop".
 */
export function LiveStep({
  agentId,
  work,
  call: live,
  label,
  now,
}: {
  agentId: string;
  work: TurnWork | undefined;
  /** The call the line is saying (`liveCallShown`), if it is saying one. */
  call: LiveCall | undefined;
  /** The Mac's own words for the line, when it isn't a call. */
  label: string;
  now: number;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [showLife, setShowLife] = useState(false);
  const [outputOpenAt, setOutputOpenAt] = useState<number | null>(null);
  const [answer, setAnswer] = useState<{ at: number; text: string } | null>(null);
  const [busy, setBusy] = useState<'check' | 'step' | 'stop' | null>(null);
  const canStopStep = useServed('agents.stopStep');
  const canCheck = useServed('agents.checkOn');
  const quiet = quietLine(work, now);
  const text = quiet ?? live?.label ?? label;
  const timer = !quiet && live ? formatElapsed(now - live.startedAt) : null;
  const hint = quiet ? null : slowHint(live, now);
  const life = showLife ? lifeLine(work, now) : null;
  const command = live?.kind === 'command';
  const outputOpen = !!live && outputOpenAt === live.startedAt;
  const note = live ? outputNote(live) : null;
  const stopStep = canStopStep && !quiet && offersStopStep(live, now);
  // An answer belongs to the call (or the quiet turn) it was about.
  const about = live?.startedAt ?? work?.startedAt ?? 0;
  const shownAnswer = answer?.at === about ? answer.text : null;
  const ask = async (kind: 'check' | 'step', method: 'agents.checkOn' | 'agents.stopStep') => {
    setBusy(kind);
    try {
      setAnswer({ at: about, text: await call(method, { agentId }) });
    } catch (error) {
      setAnswer({ at: about, text: describeError(error) });
    } finally {
      setBusy(null);
    }
  };
  const stopTurn = async () => {
    setBusy('stop');
    try {
      await stop(agentId);
    } catch (error) {
      setAnswer({ at: about, text: describeError(error) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <View style={styles.live}>
      <Pressable
        onPress={() => {
          haptic.select();
          setShowLife((s) => !s);
        }}
        disabled={work?.lastSignAt == null}
        accessibilityRole="button"
        accessibilityLabel={timer ? `${text}, ${timer}` : text || 'Working'}
        accessibilityHint="Shows when it last did something"
        style={({ pressed }) => [styles.liveLine, pressed && PRESSED]}
        testID="live-step"
      >
        {/* No progress: the dots stop claiming it's busy. */}
        {quiet ? (
          <Icon name="clock" size={iconSize.inline} color={colors.textMuted} />
        ) : (
          <TypingDots />
        )}
        {!!text && (
          <T variant="small" color={colors.textSecondary} numberOfLines={1} style={styles.liveText}>
            {text}
          </T>
        )}
        {timer && (
          <T variant="small" color={colors.textMuted} style={styles.count}>
            {timer}
          </T>
        )}
      </Pressable>
      {(hint || life) && (
        <View style={styles.liveIndent}>
          {hint && (
            <T variant="caption" color={colors.textMuted}>
              {hint}
            </T>
          )}
          {life && (
            <T variant="caption" color={colors.textMuted} testID="life-line">
              {life}
            </T>
          )}
        </View>
      )}
      {command && !quiet && live && (
        <View style={styles.liveIndent}>
          <Toggle
            open={outputOpen}
            label={outputOpen ? 'Hide output' : 'Show output'}
            hint={outputOpen ? 'Hides what it is printing' : 'Shows what it is printing'}
            onPress={() => setOutputOpenAt(outputOpen ? null : live.startedAt)}
          />
          {outputOpen &&
            (note ? (
              <T variant="caption" color={colors.textMuted}>
                {note}
              </T>
            ) : (
              <Output lines={live.output ?? []} />
            ))}
        </View>
      )}
      {(quiet || stopStep) && (
        <View style={[styles.liveIndent, styles.actions]}>
          {quiet && canCheck && (
            <Button
              title="Check on it"
              size="compact"
              variant="secondary"
              busy={busy === 'check'}
              onPress={() => void ask('check', 'agents.checkOn')}
            />
          )}
          {quiet && (
            <Button
              title="Stop"
              size="compact"
              variant="outline"
              busy={busy === 'stop'}
              onPress={() => void stopTurn()}
            />
          )}
          {stopStep && (
            <Button
              title="Stop this step"
              size="compact"
              variant="outline"
              busy={busy === 'step'}
              onPress={() => void ask('step', 'agents.stopStep')}
            />
          )}
        </View>
      )}
      {shownAnswer && (
        <View style={styles.liveIndent}>
          <T variant="caption" color={colors.textSecondary} testID="check-answer">
            {shownAnswer}
          </T>
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  wrap: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start' },
  steps: { gap: space.sm },
  stepBlock: { gap: space.xs },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  icon: { width: iconSize.body, alignItems: 'center' },
  label: { flex: 1 },
  note: { fontStyle: 'italic' as const },
  count: { fontVariant: ['tabular-nums'] },
  indent: { paddingLeft: iconSize.body + space.sm },
  output: {
    marginTop: space.xs,
    padding: space.sm,
    borderRadius: radius.inner,
    backgroundColor: colors.surfaceControl,
    gap: space['3xs'],
  },
  mono: { fontFamily: fonts.mono },
  live: { gap: space.tight },
  liveLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm, alignSelf: 'stretch' },
  liveText: { flexShrink: 1 },
  // Under the words, past the dots.
  liveIndent: { paddingLeft: space.xl + space.xs, gap: space.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
}));
