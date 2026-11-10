/**
 * A message's blocks (`show`, `agents/blocks.rs`), as the desk draws them:
 * the agent's words, then each block. A chart, a table, a form, a checklist
 * or steps is a Card (its title, when it has one, in the card's head);
 * metric tiles, quick replies, links, a callout, code and an image sit in
 * the reply as they are. Everything is drawn from data: there is no markup
 * to run, and a link shows only its domain.
 *
 * Answers go back as the user's own message (`lib/blocks.ts`), or into the
 * composer when the agent was answering outside text.
 */

import {
  isInteractive,
  type AgentMessage,
  type Block,
  type BlockSet,
} from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { View } from 'react-native';
import { haptic } from '../../lib/haptics';
import { useBlockReplies } from '../../lib/blocks';
import { makeStyles, useColors } from '../../lib/appearance';
import type { SFName } from '../../lib/icons';
import { iconSize, space } from '../../lib/theme';
import { Markdown } from '../Markdown';
import { Card } from '../surfaces';
import { Icon, T } from '../ui';
import { BlockChart } from './BlockChart';
import { BlockTable } from './BlockTable';
import {
  BlockCallout,
  BlockChecklist,
  BlockCode,
  BlockFacts,
  BlockImage,
  BlockLinks,
  BlockMetrics,
  BlockSteps,
  checklistMeta,
} from './BlockParts';
import { BlockChoices, BlockComparison, BlockForm, type Answering } from './BlockAsk';

/** The words a block from outside text leaves in the composer, not sent. */
export const STAGED_NOTE =
  'This came from something an agent read outside the app, so a tap puts the words in your message for you to check and send.';

export function Blocks({ message, set }: { message: AgentMessage; set: BlockSet }) {
  const styles = useStyles();
  const colors = useColors();
  const replies = useBlockReplies();
  // Tapped here: hold still at once, before the chat has the message.
  const [said, setSaid] = useState<string | null>(null);
  const [staged, setStaged] = useState(false);
  const answer = replies?.answerOf(message.id) ?? said;
  const outside = !!set.fromOutside;
  const answering: Answering = {
    live: !!replies && answer == null,
    answer,
    reply: (text) => {
      if (!replies) return;
      haptic.light();
      replies.reply(message.agentId, text, outside);
      if (outside) setStaged(true);
      else setSaid(text);
    },
  };
  const asks = set.items.some(isInteractive);
  return (
    <View style={styles.blocks} testID="blocks">
      {!!set.intro && <Markdown text={set.intro} />}
      {set.items.map((b, i) => (
        <BlockView key={i} block={b} agentId={message.agentId} answering={answering} />
      ))}
      {outside && asks && (
        <View style={styles.note} testID="blocks-outside">
          <Icon name="info.circle" size={iconSize.inline} color={colors.textMuted} />
          <T variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
            {staged ? 'In your message, ready for you to check and send.' : STAGED_NOTE}
          </T>
        </View>
      )}
    </View>
  );
}

const CARD_ICON: Partial<Record<Block['kind'], SFName>> = {
  table: 'tablecells',
  facts: 'list.bullet',
  checklist: 'checklist',
  steps: 'list.number',
  comparison: 'square.split.2x1',
  form: 'square.and.pencil',
};

function chartIcon(b: Block): SFName {
  if (b.kind !== 'chart') return 'chart.xyaxis.line';
  return b.chart === 'bar'
    ? 'chart.bar'
    : b.chart === 'pie' || b.chart === 'donut'
      ? 'chart.pie'
      : 'chart.xyaxis.line';
}

function BlockView({
  block,
  agentId,
  answering,
}: {
  block: Block;
  agentId: string;
  answering: Answering;
}) {
  const colors = useColors();
  const styles = useStyles();
  const title = block.title?.trim();
  switch (block.kind) {
    case 'metrics':
      return (
        <View style={styles.bare}>
          {!!title && <Heading text={title} />}
          <BlockMetrics block={block} />
        </View>
      );
    case 'choices':
      return (
        <View style={styles.bare}>
          {!!title && <Heading text={title} />}
          <BlockChoices block={block} answering={answering} />
        </View>
      );
    case 'links':
      return (
        <View style={styles.bare}>
          {!!title && <Heading text={title} />}
          <BlockLinks block={block} />
        </View>
      );
    case 'callout':
      return <BlockCallout block={block} />;
    case 'code':
      return (
        <View style={styles.bare}>
          {!!title && (
            <T variant="caption" color={colors.textMuted}>
              {title}
            </T>
          )}
          <BlockCode block={block} />
        </View>
      );
    case 'image':
      return <BlockImage block={block} agentId={agentId} />;
    case 'chart':
      if (block.chart === 'sparkline') {
        return (
          <View style={styles.bare}>
            {!!title && <Heading text={title} />}
            <BlockChart block={block} />
          </View>
        );
      }
      return (
        <Card icon={chartIcon(block)} title={title ?? ''} hideHead={!title} testID="block-card">
          <BlockChart block={block} />
        </Card>
      );
    case 'table':
      return (
        <Card
          icon={CARD_ICON.table!}
          title={title ?? ''}
          hideHead={!title}
          meta={`${block.rows.length} ${block.rows.length === 1 ? 'row' : 'rows'}`}
          testID="block-card"
        >
          <BlockTable block={block} />
        </Card>
      );
    case 'facts':
      return (
        <Card icon={CARD_ICON.facts!} title={title ?? ''} hideHead={!title} testID="block-card">
          <BlockFacts block={block} />
        </Card>
      );
    case 'checklist':
      return (
        <Card
          icon={CARD_ICON.checklist!}
          title={title ?? 'Checklist'}
          meta={checklistMeta(block)}
          testID="block-card"
        >
          <BlockChecklist block={block} />
        </Card>
      );
    case 'steps':
      return (
        <Card icon={CARD_ICON.steps!} title={title ?? 'Steps'} testID="block-card">
          <BlockSteps block={block} />
        </Card>
      );
    case 'comparison':
      return (
        <Card icon={CARD_ICON.comparison!} title={title ?? 'Options'} testID="block-card">
          <BlockComparison block={block} answering={answering} />
        </Card>
      );
    case 'form':
      return (
        <Card icon={CARD_ICON.form!} title={title ?? 'A few details'} testID="block-card">
          <BlockForm block={block} answering={answering} />
        </Card>
      );
    default:
      // A kind this phone doesn't draw: its words.
      return (
        <T variant="body" color={colors.textBody}>
          {(block as { summary?: string }).summary ?? ''}
        </T>
      );
  }
}

function Heading({ text }: { text: string }) {
  const colors = useColors();
  return (
    <T variant="headline" color={colors.textStrong} accessibilityRole="header">
      {text}
    </T>
  );
}

const useStyles = makeStyles(() => ({
  blocks: { gap: space.md },
  bare: { gap: space.sm },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: space.tight },
}));
