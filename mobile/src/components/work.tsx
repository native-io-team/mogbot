/**
 * What a turn did, as on the desktop (`AgentWork.tsx`): under the message it
 * ended on, one quiet line that opens into the steps; while the agent works,
 * the working line itself says how many steps so far and opens into them
 * (`LiveStep`). Only what the Mac recorded; a message without `work` (or
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
import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { call, describeError, stop } from '../lib/session';
import { useServed } from '../lib/store';
import { useTurnSteps } from '../lib/turnSteps';
import { fonts, iconSize, keySize, radius, space, PRESSED } from '../lib/theme';

/** The column the line's key leads: the desk's small key, with room for its edge. */
const LEAD = keySize.sm + space.xs;
import {
  earlierSteps,
  liveSteps,
  stepOffset,
  stepOffsetSpoken,
  stepSymbol,
  workSummary,
} from '../lib/work';
import { AgentKey } from './AgentKey';
import { Attachments } from './attachments';
import { Shimmer } from './Shimmer';
import { TypingDots } from './TypingDots';
import { Icon, T } from './ui';

/** The chevron and its words: the same control folded and open. */
function Toggle({
  open,
  label,
  onPress,
  hint = open ? 'Hides the steps' : 'Shows each step',
  inline = false,
}: {
  open: boolean;
  label: string;
  onPress: () => void;
  hint?: string;
  /** Inside a step (Show output): the chevron on the step's words' edge, not in a column. */
  inline?: boolean;
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
      style={({ pressed }) => [styles.head, inline && styles.headInline, pressed && PRESSED]}
    >
      {/* In the steps' icon column, where the working line's key cap sat. */}
      <View style={!inline && styles.icon}>
        <Icon
          name={open ? 'chevron.down' : 'chevron.right'}
          size={iconSize.inline}
          color={colors.textMuted}
        />
      </View>
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
            inline
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
  current,
}: {
  work: TurnWork;
  steps: WorkStep[];
  agentId: string;
  onError: (text: string) => void;
  files: boolean;
  /** While it works: the step it's on, last. */
  current?: ReactNode;
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
      {current}
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
      {open && <FinishedSteps message={message} work={work} onError={onError} />}
    </View>
  );
}

/** The steps once read (`useTurnSteps`), or a line saying where they are. */
function FinishedSteps({
  message,
  work,
  onError,
}: {
  message: AgentMessage;
  work: TurnWork;
  onError: (text: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const steps = useTurnSteps(message.agentId, message.id, work, true);
  if (steps.state === 'ready') {
    return (
      <Steps
        work={steps.work}
        steps={steps.work.steps}
        agentId={message.agentId}
        onError={onError}
        files
      />
    );
  }
  const words =
    steps.state === 'reading'
      ? 'Reading the steps…'
      : steps.state === 'gone'
        ? 'Its steps are no longer kept.'
        : 'Couldn’t read the steps.';
  return (
    <View style={styles.steps}>
      <T variant="caption" color={colors.textMuted} style={styles.indent}>
        {words}
      </T>
      {steps.state === 'failed' && (
        <Pressable
          onPress={steps.retry}
          accessibilityRole="button"
          style={({ pressed }) => [styles.indent, pressed && PRESSED]}
        >
          <T variant="caption" color={colors.textSecondary}>
            Try again
          </T>
        </Pressable>
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

/** A quiet action in words: "Check on it", "Stop", "Stop this step". */
function TextAction({
  title,
  hint,
  busy,
  onPress,
}: {
  title: string;
  hint: string;
  busy: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => {
        haptic.select();
        onPress();
      }}
      disabled={busy}
      hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
      accessibilityState={{ busy }}
      style={({ pressed }) => [(pressed || busy) && PRESSED]}
    >
      <T variant="small" color={colors.textPrimary}>
        {title}
      </T>
    </Pressable>
  );
}

/** The step it's on, last in the opened list: present tense, its own timer, its output. */
function CurrentStep({
  call: live,
  now,
  life,
}: {
  call: LiveCall;
  now: number;
  life: string | null;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [outputOpenAt, setOutputOpenAt] = useState<number | null>(null);
  const outputOpen = outputOpenAt === live.startedAt;
  const note = outputNote(live);
  const timer = formatElapsed(now - live.startedAt);
  return (
    <View style={styles.stepBlock} testID="work-step-current">
      <View style={styles.step} accessible accessibilityLabel={`${live.label}, ${timer}`}>
        <View style={styles.icon}>
          <Icon name={stepSymbol(live.kind)} size={iconSize.inline} color={colors.textMuted} />
        </View>
        <T variant="caption" color={colors.textPrimary} numberOfLines={2} style={styles.label}>
          {live.label}
        </T>
        <T variant="caption" color={colors.textMuted} style={styles.count}>
          {timer}
        </T>
      </View>
      {life && (
        <T variant="caption" color={colors.textMuted} style={styles.indent} testID="life-line">
          {life}
        </T>
      )}
      {live.kind === 'command' && (
        <View style={styles.indent}>
          <Toggle
            open={outputOpen}
            inline
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
    </View>
  );
}

/**
 * The working row, as on the desk (`AgentWorkingIndicator.tsx`): one line,
 * no bubble. The agent's key cap looking around, then what it's doing with a
 * soft shimmer while it's live, and muted at the end how many steps so far
 * and how long the turn has run ("Running the Cypress tests · 5 steps ·
 * 6:02"). The line is the toggle: tapping it opens the steps under it, in
 * the column the finished timeline uses, ending on the step it's on now
 * with its own timer, when it last showed life and "Show output". Under the
 * line, on the words' edge: the hint a known slow tool gets after a minute
 * and what a check found; quiet text actions sit at the right edge (Stop
 * this step after ten minutes; "Check on it" and "Stop" once the Mac says
 * there's been no progress, when the line stops shimmering). A phone line
 * is too narrow to share with them, so they take a row of their own.
 */
export function LiveStep({
  agentId,
  agent,
  work,
  call: live,
  label,
  now,
  activity,
  onError = () => {},
  bare = false,
}: {
  agentId: string;
  /** Under a speaker's name (a room): the name's key cap leads, the line starts on the prose's edge. */
  bare?: boolean;
  /** Who leads the line, as its key, pressed while it works (`AgentKey`); without one, the typing dots. */
  agent?: { name: string; color: string };
  work: TurnWork | undefined;
  /** The call the line is saying (`liveCallShown`), if it is saying one. */
  call: LiveCall | undefined;
  /** The Mac's own words for the line, when it isn't a call. */
  label: string;
  now: number;
  /** The status's words, which say whether the newest step is the line's (`liveSteps`). */
  activity?: string | null;
  onError?: (text: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [answer, setAnswer] = useState<{ at: number; text: string } | null>(null);
  const [busy, setBusy] = useState<'check' | 'step' | 'stop' | null>(null);
  const canStopStep = useServed('agents.stopStep');
  const canCheck = useServed('agents.checkOn');
  const quiet = quietLine(work, now);
  const words = quiet ? `${quiet}${live ? ` · ${live.label}` : ''}` : (live?.label ?? label);
  const count = work && work.stepCount > 0 ? plural(work.stepCount) : null;
  const elapsed =
    work && now - work.startedAt >= 1_000 ? formatElapsed(now - work.startedAt) : null;
  const meta = [count, elapsed].filter(Boolean).join(' · ');
  const hint = quiet ? null : slowHint(live, now);
  const life = lifeLine(work, now);
  const stopStep = canStopStep && !quiet && offersStopStep(live, now);
  // Open belongs to this turn: the next one starts folded.
  const canOpen = !!work && (work.stepCount > 0 || !!live);
  const open = canOpen && openAt === work?.startedAt;
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
  // The steps so far, without the one the line is saying: it's the last row.
  const steps = work
    ? live
      ? work.steps.filter((s, i) => !(i === work.steps.length - 1 && s.at === live.startedAt))
      : liveSteps(work, activity ?? null)
    : [];
  const spoken = [words || 'Working', meta].filter(Boolean).join(', ');
  return (
    <View style={styles.live}>
      <Pressable
        onPress={() => {
          if (!canOpen || !work) return;
          haptic.select();
          setOpenAt(open ? null : work.startedAt);
        }}
        disabled={!canOpen}
        hitSlop={{ top: 10, bottom: 10 }}
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityHint={open ? 'Hides the steps' : 'Shows each step'}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.liveLine, pressed && PRESSED]}
        testID="live-step"
      >
        {!bare && (
          <View style={styles.icon}>
            {agent ? (
              <AgentKey
                id={agentId}
                name={agent.name}
                color={agent.color}
                state={quiet ? 'idle' : 'working'}
                size={keySize.sm}
              />
            ) : (
              <TypingDots />
            )}
          </View>
        )}
        {/* Words and count as one run of text: the row's gap is for the key cap. */}
        <View style={styles.liveWords}>
          {/* Full strength breathing down to about secondary: the desk's range. */}
          {!!words && (
            <Shimmer live={!quiet} style={styles.liveText}>
              <T variant="small" color={colors.textPrimary} numberOfLines={1}>
                {words}
              </T>
            </Shimmer>
          )}
          {!!meta && (
            <T
              variant="small"
              color={colors.textMuted}
              numberOfLines={1}
              style={[styles.count, styles.meta]}
            >
              {words ? `\u00a0· ${meta}` : meta}
            </T>
          )}
        </View>
      </Pressable>
      {open && work && (
        <Steps
          work={work}
          steps={steps}
          agentId={agentId}
          onError={onError}
          files={false}
          current={live && !quiet ? <CurrentStep call={live} now={now} life={life} /> : null}
        />
      )}
      {(hint || (quiet && life) || shownAnswer) && (
        <View style={[styles.liveIndent, bare && styles.bare]}>
          {quiet && life && (
            <T variant="caption" color={colors.textMuted} testID="life-line">
              {life}
            </T>
          )}
          {hint && (
            <T variant="caption" color={colors.textMuted}>
              {hint}
            </T>
          )}
          {shownAnswer && (
            <T variant="caption" color={colors.textSecondary} testID="check-answer">
              {shownAnswer}
            </T>
          )}
        </View>
      )}
      {(quiet || stopStep) && (
        <View style={styles.actions}>
          {quiet && canCheck && (
            <TextAction
              title="Check on it"
              hint="Asks the Mac what it’s doing, without stopping it"
              busy={busy === 'check'}
              onPress={() => void ask('check', 'agents.checkOn')}
            />
          )}
          {quiet && (
            <TextAction
              title="Stop"
              hint="Stops what it’s doing"
              busy={busy === 'stop'}
              onPress={() => void stopTurn()}
            />
          )}
          {stopStep && (
            <TextAction
              title="Stop this step"
              hint="Stops what it’s running now; it carries on from there"
              busy={busy === 'step'}
              onPress={() => void ask('step', 'agents.stopStep')}
            />
          )}
        </View>
      )}
    </View>
  );
}

const plural = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`;

const useStyles = makeStyles((colors) => ({
  wrap: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm, alignSelf: 'flex-start' },
  steps: { gap: space.sm },
  stepBlock: { gap: space.xs },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // The steps' icon column: the typing key's width, so the live line, its
  // steps and the folded "Worked" line share one grid.
  icon: { width: LEAD, alignItems: 'center' },
  label: { flex: 1 },
  note: { fontStyle: 'italic' as const },
  count: { fontVariant: ['tabular-nums'] },
  indent: { paddingLeft: LEAD + space.sm },
  output: {
    marginTop: space.xs,
    padding: space.sm,
    borderRadius: radius.inner,
    backgroundColor: colors.surfaceControl,
    gap: space['3xs'],
  },
  mono: { fontFamily: fonts.mono },
  live: { gap: space.sm },
  // The key cap in the steps' icon column, the words on their label edge.
  liveLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm, alignSelf: 'stretch' },
  liveWords: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  liveText: { flexShrink: 1 },
  // The count and time never wrap: the words give way first.
  meta: { flexShrink: 0 },
  headInline: { gap: space.xs },
  // Under the line, on the words' edge.
  liveIndent: { paddingLeft: LEAD + space.sm, gap: space.xs },
  // Quiet actions at the right edge, a row of their own on a phone's line.
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.lg },
  bare: { paddingLeft: 0 },
}));
