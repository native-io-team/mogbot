import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AgentBlocks } from './AgentBlocks';
import { BlockReplyContext, type BlockReply } from './blockReply';
import type { Agent } from '../../../lib/agents';
import type { Block, BlockSet } from '../../../../packages/companion-protocol/src/blocks';
import { answerAfter, readBlocks } from '../../../../packages/companion-protocol/src/blocks';
import type { AgentMessage } from '../../../../packages/companion-protocol/src/model';
import turn from '../../../../packages/companion-protocol/src/blocks-turn.json';

const agent = { id: 'finance', name: 'Finance' } as Agent;

function draw(items: Block[], opts: { reply?: Partial<BlockReply>; outside?: boolean } = {}) {
  const reply: BlockReply = {
    send: vi.fn(),
    stage: vi.fn(),
    answerOf: () => null,
    ...opts.reply,
  };
  const set: BlockSet = { v: 1, intro: 'Here it is.', items, fromOutside: opts.outside };
  const view = render(
    <BlockReplyContext.Provider value={reply}>
      <AgentBlocks messageId="m1" agent={agent} set={set} />
    </BlockReplyContext.Provider>
  );
  return { ...view, reply };
}

const choices: Block = {
  kind: 'choices',
  summary: '',
  question: 'Ship it?',
  options: [
    { label: 'Yes', reply: 'Yes, ship it.' },
    { label: 'Not yet', reply: 'Not yet.' },
  ],
};

describe('AgentBlocks', () => {
  it('draws records and notes in a row as one page, a section each', () => {
    const { container } = draw([
      {
        kind: 'facts',
        title: 'Needs you',
        summary: '',
        items: [{ label: 'Lead Gen', value: 'Send' }],
      },
      { kind: 'callout', tone: 'warning', title: 'Didn’t work', summary: '', text: 'Gmail.' },
      {
        kind: 'table',
        title: 'Today',
        summary: '',
        columns: [{ label: 'Time' }, { label: 'Runs', numeric: true }],
        rows: [['10:30 AM', 2]],
      },
    ]);
    const pages = container.querySelectorAll('.agent-blocks__page');
    expect(pages).toHaveLength(1);
    expect(within(pages[0] as HTMLElement).getByRole('heading', { name: 'Today' })).toBeTruthy();
    // No card of its own inside the page.
    expect(pages[0].querySelectorAll('.agent-card')).toHaveLength(0);
    // A time never breaks over two lines.
    expect(screen.getByText('10:30 AM').closest('[data-short]')).toBeTruthy();
  });

  it('draws the intro and a chart as an image with a name, its numbers a click away', () => {
    draw([
      {
        kind: 'chart',
        chart: 'line',
        title: 'Revenue',
        summary: '',
        labels: ['Jan', 'Feb', 'Mar'],
        prefix: '$',
        series: [{ name: 'Revenue', values: [1000, 1500, 2000] }],
      },
    ]);
    expect(screen.getByText('Here it is.')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Revenue (line chart, Jan to Mar)' })).toBeTruthy();
    // One series: no legend box.
    expect(screen.queryByLabelText('Legend')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the numbers' }));
    expect(screen.getByText('$1,500')).toBeTruthy();
  });

  it('arrow keys move the chart’s tooltip', () => {
    draw([
      {
        kind: 'chart',
        chart: 'bar',
        summary: '',
        labels: ['Q1', 'Q2'],
        series: [
          { name: 'A', values: [1, 2] },
          { name: 'B', values: [3, 4] },
        ],
      },
    ]);
    const chart = screen.getByRole('img');
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    const tip = screen.getByRole('status');
    expect(within(tip).getByText('Q1')).toBeTruthy();
    expect(within(tip).getByText('3')).toBeTruthy();
    expect(screen.getByLabelText('Legend')).toBeTruthy();
  });

  it('a choice sends the user’s words once, then shows what was picked', () => {
    const { reply } = draw([choices]);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(reply.send).toHaveBeenCalledWith('Yes, ship it.');
    expect(screen.queryByRole('button', { name: 'Not yet' })).toBeNull();
  });

  it('an answered choice shows the answer and offers nothing', () => {
    draw([choices], { reply: { answerOf: () => 'Not yet.' } });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Not yet')).toBeTruthy();
  });

  it('blocks from outside text stage the words, never send them', () => {
    const { reply } = draw([choices], { outside: true });
    expect(screen.getByText(/goes into your message first/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(reply.stage).toHaveBeenCalledWith('Yes, ship it.');
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('a form asks for what it needs, then sends plain lines', () => {
    const { reply } = draw([
      {
        kind: 'form',
        title: 'Event',
        summary: '',
        submit: 'Send details',
        fields: [
          { id: 'name', label: 'Name', type: 'text', required: true },
          { id: 'where', label: 'Where', type: 'choice', options: ['Office', 'Online'] },
        ],
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Send details' }));
    expect(screen.getByRole('alert').textContent).toBe('Needed');
    expect(reply.send).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Launch' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Online' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send details' }));
    expect(reply.send).toHaveBeenCalledWith('Event\nName: Launch\nWhere: Online');
    expect(screen.getByText('Sent')).toBeTruthy();
  });

  it('Pick this sends the option’s reply; the recommended one is strong, never accent', () => {
    const { reply } = draw([
      {
        kind: 'comparison',
        summary: '',
        options: [
          { name: 'A', pros: ['fast'], cons: [], recommended: true, reply: 'Go with A.' },
          { name: 'B', pros: [], cons: ['slow'], reply: 'Go with B.' },
        ],
      },
    ]);
    const picks = screen.getAllByRole('button', { name: 'Pick this' });
    expect(picks[0].className).toContain('button--strong');
    expect(picks[0].className).not.toContain('button--primary');
    fireEvent.click(picks[1]);
    expect(reply.send).toHaveBeenCalledWith('Go with B.');
  });

  it('a table sorts by a column and shows the rest on request', () => {
    const rows = Array.from({ length: 10 }, (_, i) => [`r${i}`, i]);
    draw([
      {
        kind: 'table',
        summary: '',
        columns: [{ label: 'Name' }, { label: 'N', numeric: true }],
        rows,
      },
    ]);
    expect(screen.getAllByRole('row')).toHaveLength(9);
    fireEvent.click(screen.getByRole('button', { name: 'N' }));
    expect(screen.getAllByRole('row')[1].textContent).toContain('r9');
    fireEvent.click(screen.getByRole('button', { name: 'Show all 10 rows' }));
    expect(screen.getAllByRole('row')).toHaveLength(11);
  });

  it('text is drawn as text, never markup', () => {
    const { container } = draw([
      { kind: 'callout', tone: 'warning', summary: '', text: '<img src=x onerror=alert(1)>' },
      { kind: 'facts', summary: '', items: [{ label: '<b>L</b>', value: '<script>x</script>' }] },
    ]);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    // A callout names its tone in words, not colour alone.
    expect(screen.getByText('Heads up')).toBeTruthy();
  });

  it('metrics show the value, the delta’s direction in words, and links their domain', () => {
    draw([
      {
        kind: 'metrics',
        summary: '',
        items: [{ label: 'Refunds', value: 1240, prefix: '$', delta: -380, good: 'down' }],
      },
      {
        kind: 'links',
        summary: '',
        items: [{ url: 'https://docs.rs/x', label: 'Docs', domain: 'docs.rs' }],
      },
    ]);
    expect(screen.getByText('$1,240')).toBeTruthy();
    expect(screen.getByText('Down').closest('[data-tone]')?.getAttribute('data-tone')).toBe('good');
    expect(screen.getByRole('button', { name: /Docs/ }).textContent).toContain('docs.rs');
  });

  it('without a chat to answer in, interactive blocks are off', () => {
    render(<AgentBlocks messageId="m1" agent={agent} set={{ v: 1, items: [choices] }} />);
    expect(screen.getByRole('button', { name: 'Yes' })).toHaveProperty('disabled', true);
  });
});

/*
 * A real turn's blocks: `blocks-turn.json` is what the fake-engine suite's
 * `blocks` scenario kept after an agent's `show` (metrics, a chart, a table
 * and a choice) and the user's answer, as `agents_messages` returns them.
 * That scenario fails if the Mac stops producing exactly this.
 */
describe('a turn’s blocks, as the Mac kept them', () => {
  const messages = turn.messages as unknown as AgentMessage[];
  const [shown, answer] = messages;

  function drawKept(answerOf: (id: string) => string | null) {
    const set = readBlocks(shown)!;
    const reply: BlockReply = { send: vi.fn(), stage: vi.fn(), answerOf };
    render(
      <BlockReplyContext.Provider value={reply}>
        <AgentBlocks messageId={shown.id} agent={agent} set={set} />
      </BlockReplyContext.Provider>
    );
    return reply;
  }

  it('reads every block and draws it', () => {
    expect(readBlocks(shown)!.items.map((b) => b.kind)).toEqual([
      'metrics',
      'chart',
      'table',
      'choices',
    ]);
    drawKept(() => null);
    expect(screen.getByText("Here's the fruit stand this week.")).toBeTruthy();
    expect(screen.getByText('412')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Sold per day/ })).toBeTruthy();
    expect(screen.getByText('$2.75')).toBeTruthy();
    expect(screen.getByText('Which one do you want?')).toBeTruthy();
  });

  it('a tap sends exactly the words the Mac then kept as the user’s answer', () => {
    const reply = drawKept(() => null);
    fireEvent.click(screen.getByRole('button', { name: 'Mango' }));
    expect(reply.send).toHaveBeenCalledWith(answer.text);
  });

  it('once answered, shows the pick and offers nothing', () => {
    const reply = drawKept((id) => answerAfter(messages, id));
    expect(screen.queryByRole('button', { name: 'Apple' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mango' })).toBeNull();
    const picked = document.querySelectorAll('.agent-block-choices__picked');
    expect([...picked].map((p) => p.textContent)).toEqual(['Mango']);
    expect(reply.send).not.toHaveBeenCalled();
  });
});
