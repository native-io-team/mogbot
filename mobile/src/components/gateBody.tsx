/**
 * The body of "OK to go on?" between a routine's steps
 * (`agents/routine_steps.rs`): what comes next, word for word, then what
 * the step before produced, as the agent wrote it, in a quiet well with
 * "Show all" once it's long. Go ahead says yes to exactly this.
 */

import type { Approval } from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { radius, space } from '../lib/theme';
import { Markdown, MarkdownSurface } from './Markdown';
import { ShowAll } from './ShowAll';
import { T } from './ui';

/** Past this many characters the draft folds behind "Show all". */
const FOLD_AT = 280;

export function GateBody({ approval }: { approval: Approval }) {
  const colors = useColors();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const gate = approval.gate;
  if (!gate) return null;
  const draft = approval.detail.trim();
  const long = draft.length > FOLD_AT;
  const shown = long && !open ? `${draft.slice(0, FOLD_AT).trimEnd()}…` : draft;
  return (
    <View style={styles.root}>
      <View style={styles.next}>
        <T variant="caption" color={colors.textMuted}>
          Next, step {gate.done + 1} of {gate.total}
        </T>
        <T color={colors.textStrong}>{gate.next}</T>
      </View>
      {!!draft && (
        <View style={styles.well} accessibilityLabel={`What step ${gate.done} produced`}>
          <T variant="caption" color={colors.textMuted} style={styles.wellHead}>
            What step {gate.done} made
          </T>
          <View style={styles.wellBody}>
            <MarkdownSurface.Provider value={colors.surfaceGroup}>
              <Markdown text={shown} />
            </MarkdownSurface.Provider>
          </View>
          {long && <ShowAll open={open} onPress={() => setOpen((v) => !v)} />}
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { gap: space.md },
  next: { gap: space['2xs'] },
  well: {
    borderRadius: radius.inner,
    backgroundColor: colors.surfaceGroup,
    overflow: 'hidden',
  },
  wellHead: { paddingHorizontal: space.md, paddingTop: space.sm },
  wellBody: { paddingHorizontal: space.md, paddingVertical: space.sm },
}));
