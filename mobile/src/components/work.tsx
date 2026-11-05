/**
 * What a turn did, as on the desktop (`AgentWork.tsx`): under the message it
 * ended on, one quiet line that opens into the steps; while the agent works,
 * a folded "Working · 8 steps" under the working row that opens into the
 * steps so far. Only what the Mac recorded; a message without `work` (or
 * from an older Mac) shows nothing.
 */

import type { AgentMessage, TurnWork, WorkStep } from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { iconSize, space } from '../lib/theme';
import {
  earlierSteps,
  liveSteps,
  liveSummary,
  stepOffset,
  stepSymbol,
  workSummary,
} from '../lib/work';
import { Attachments } from './attachments';
import { Icon, T } from './ui';

/** The chevron and its words: the same control folded and open. */
function Toggle({ open, label, onPress }: { open: boolean; label: string; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      onPress={() => {
        haptic.select();
        onPress();
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      style={styles.head}
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
  const quiet = step.outcome != null;
  return (
    <View style={styles.stepBlock} testID={`work-step-${step.kind}`}>
      <View style={styles.step}>
        <View style={styles.icon}>
          <Icon name={stepSymbol(step.kind)} size={iconSize.inline} color={colors.textMuted} />
        </View>
        <T
          variant="caption"
          color={quiet ? colors.textMuted : colors.textSecondary}
          numberOfLines={1}
          style={styles.label}
        >
          {step.label}
        </T>
        <T variant="caption" color={colors.textMuted} style={styles.count}>
          {stepOffset(step, startedAt)}
        </T>
      </View>
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
        <Steps
          work={work}
          steps={work.steps}
          agentId={message.agentId}
          onError={onError}
          files
        />
      )}
    </View>
  );
}

/**
 * Under the working row while it works: "Working · 8 steps", folded, opening
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

const useStyles = makeStyles(() => ({
  wrap: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start' },
  steps: { gap: space.sm },
  stepBlock: { gap: space.xs },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  icon: { width: iconSize.body, alignItems: 'center' },
  label: { flex: 1 },
  count: { fontVariant: ['tabular-nums'] },
  indent: { paddingLeft: iconSize.body + space.sm },
}));
