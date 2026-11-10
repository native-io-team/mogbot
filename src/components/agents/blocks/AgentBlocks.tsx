/**
 * Blocks (`show`, `agents/blocks.rs`): an agent's answer drawn from data.
 * The agent's words above, then each block in the conversation's language:
 * charts, tables, facts, checklists, steps, comparisons and forms on a Card;
 * metrics as tiles; quick replies as a row of neutral buttons; links as
 * chips; a callout as a tinted note with its icon and word. Nothing here is
 * markup from the agent: every string is drawn as text.
 *
 * Answering one goes through `BlockReplyContext`: the chat's own send, or,
 * for blocks posted while the agent was answering outside text, the
 * composer, for the user to read first.
 *
 * @module components/agents/blocks/AgentBlocks
 */

import { memo, type ReactNode } from 'react';
import type { Agent } from '../../../lib/agents';
import {
  blockRuns,
  isInteractive,
  type Block,
  type BlockSet,
} from '../../../../packages/companion-protocol/src/blocks';
import { FinishedProse } from '../AgentProse';
import { MessageAttachments } from '../AgentAttachments';
import { BlockChart } from './BlockChart';
import { BlockForm } from './BlockForm';
import {
  BlockCallout,
  BlockChecklist,
  BlockChoices,
  BlockCode,
  BlockComparison,
  BlockFacts,
  BlockLinks,
  BlockMetrics,
  BlockSteps,
} from './BlockParts';
import { BlockTable } from './BlockTable';
import { useBlockReply, type Answering } from './blockReply';

interface AgentBlocksProps {
  messageId: string;
  agent: Agent;
  set: BlockSet;
}

export const AgentBlocks = memo(function AgentBlocks({ messageId, agent, set }: AgentBlocksProps) {
  const ctx = useBlockReply();
  const answer = ctx?.answerOf(messageId) ?? null;
  const staged = !!set.fromOutside;
  const answering: Answering = {
    reply: ctx ? (staged ? ctx.stage : ctx.send) : null,
    staged,
    answer,
  };
  const asks = set.items.some(isInteractive);
  return (
    <div className="agent-blocks" data-message-id={messageId}>
      {set.intro && (
        <div className="agent-bubble agent-bubble--agent agent-markdown">
          <FinishedProse id={messageId} text={set.intro} />
        </div>
      )}
      {blockRuns(set.items).map((run, i) =>
        run.length > 1 ? (
          <div key={i} className="agent-card agent-blocks__page" data-blocks={run.length}>
            {run.map((block, j) => (
              <BlockView key={j} block={block} agent={agent} answering={answering} section />
            ))}
          </div>
        ) : (
          <BlockView key={i} block={run[0]} agent={agent} answering={answering} />
        )
      )}
      {asks && staged && answer == null && (
        <p className="agent-blocks__staged">
          This came from something it read outside the app, so your answer goes into your message
          first, for you to check and send.
        </p>
      )}
    </div>
  );
});

/** A titled card, the conversation's own surface. */
function Panel({
  block,
  children,
  bare,
  section,
}: {
  block: Block;
  children: ReactNode;
  /** Its own surface (tiles, chips, a note): only the title above it. */
  bare?: boolean;
  /** One section of a page card: its title and contents, the card around them all. */
  section?: boolean;
}) {
  const title = block.title?.trim();
  if (section) {
    return (
      <section
        className="agent-block agent-block--section"
        data-kind={block.kind}
        aria-label={title || undefined}
      >
        {title && <h3 className="agent-block__section-title">{title}</h3>}
        {children}
      </section>
    );
  }
  if (bare) {
    return (
      <section
        className="agent-block"
        data-kind={block.kind}
        data-bare
        aria-label={title || undefined}
      >
        {title && <h3 className="agent-block__title">{title}</h3>}
        {children}
      </section>
    );
  }
  return (
    <section
      className="agent-card agent-block"
      data-kind={block.kind}
      aria-label={title || undefined}
    >
      {title && <h3 className="agent-card__title agent-block__card-title">{title}</h3>}
      {children}
    </section>
  );
}

function BlockView({
  block,
  agent,
  answering,
  section,
}: {
  block: Block;
  agent: Agent;
  answering: Answering;
  /** Drawn as a section of a page card (`blockRuns`). */
  section?: boolean;
}) {
  switch (block.kind) {
    case 'chart':
      return (
        <Panel block={block} bare={block.chart === 'sparkline'}>
          <BlockChart block={block} />
        </Panel>
      );
    case 'table':
      return (
        <Panel block={block} section={section}>
          <BlockTable block={block} />
        </Panel>
      );
    case 'metrics':
      return (
        <Panel block={block} bare>
          <BlockMetrics block={block} />
        </Panel>
      );
    case 'facts':
      return (
        <Panel block={block} section={section}>
          <BlockFacts block={block} />
        </Panel>
      );
    case 'checklist':
      return (
        <Panel block={block} section={section}>
          <BlockChecklist block={block} />
        </Panel>
      );
    case 'steps':
      return (
        <Panel block={block} section={section}>
          <BlockSteps block={block} />
        </Panel>
      );
    case 'comparison':
      return (
        <Panel block={block} bare>
          <BlockComparison block={block} answering={answering} />
        </Panel>
      );
    case 'choices':
      return (
        <Panel block={block} bare>
          <BlockChoices block={block} answering={answering} />
        </Panel>
      );
    case 'form':
      return (
        <Panel block={block}>
          <BlockForm block={block} answering={answering} />
        </Panel>
      );
    case 'links':
      return (
        <Panel block={block} bare>
          <BlockLinks block={block} />
        </Panel>
      );
    case 'callout':
      return <BlockCallout block={block} />;
    case 'code':
      return (
        <Panel block={{ ...block, title: undefined }} bare>
          <BlockCode block={block} />
        </Panel>
      );
    case 'image':
      return (
        <figure className="agent-block agent-block-image" data-kind="image">
          <MessageAttachments agent={agent} attachments={[block.file]} side="agent" />
          {(block.caption || block.title) && (
            <figcaption>{block.caption ?? block.title}</figcaption>
          )}
        </figure>
      );
    default:
      return null;
  }
}
