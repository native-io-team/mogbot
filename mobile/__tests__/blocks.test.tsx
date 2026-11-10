/**
 * Blocks on the phone (`components/blocks`): every kind draws, answers go
 * back as the user's words (or stage in the composer from outside text),
 * and an answered block holds still.
 */
import type { AgentMessage, Block, BlockSet } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Blocks, STAGED_NOTE } from '../src/components/blocks/Blocks';
import { BlockRepliesContext, blockAnswers, type BlockReplies } from '../src/lib/blocks';
import { asMessage } from '../src/lib/wellFormed';

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  preset.duration = () => preset;
  preset.delay = () => preset;
  return {
    __esModule: true,
    default: { View },
    FadeIn: preset,
    FadeOut: preset,
    LinearTransition: preset,
  };
});
jest.mock('expo-haptics', () => ({}));
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('../src/lib/haptics', () => ({
  haptic: {
    light: jest.fn(),
    select: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../src/lib/session', () => ({
  attachmentSource: () => ({ uri: 'https://mac.example/a.png' }),
  describeError: String,
  send: jest.fn(),
}));
jest.mock('../src/components/agent', () => ({ Spinner: () => null }));
jest.mock('../src/components/menu', () => ({ choose: jest.fn() }));

const S = (b: Partial<Block> & { kind: Block['kind'] }) => ({ summary: 's', ...b }) as Block;

function message(items: Block[], extra: Partial<BlockSet> = {}): AgentMessage {
  return {
    id: 'm1',
    agentId: 'fin',
    ts: 1,
    kind: 'agent',
    text: 'fallback',
    blocks: { v: 1, items, ...extra },
  };
}

function draw(m: AgentMessage, replies: BlockReplies | null, wrap?: (n: ReactNode) => ReactNode) {
  const node = <Blocks message={m} set={m.blocks!} />;
  const inner = replies ? (
    <BlockRepliesContext.Provider value={replies}>{node}</BlockRepliesContext.Provider>
  ) : (
    node
  );
  return render(<>{wrap ? wrap(inner) : inner}</>);
}

const replies = (answer: string | null = null) => {
  const reply = jest.fn();
  return { reply, value: { answerOf: () => answer, reply } satisfies BlockReplies };
};

const ALL: Block[] = [
  S({
    kind: 'chart',
    chart: 'line',
    title: 'Signups',
    labels: ['Mon', 'Tue', 'Wed'],
    series: [
      { name: 'Signups', values: [1, 2, 3] },
      { name: 'Trials', values: [2, null, 1] },
    ],
  } as Partial<Block> & { kind: 'chart' }),
  S({
    kind: 'chart',
    chart: 'donut',
    labels: ['Ads', 'Search'],
    series: [{ name: 'Share', values: [3, 7] }],
  } as Partial<Block> & { kind: 'chart' }),
  S({
    kind: 'table',
    title: 'Invoices',
    columns: [{ label: 'Client' }, { label: 'Amount', numeric: true, prefix: '$' }],
    rows: [
      ['Acme', 1200],
      ['Globex', 90],
      ['Initech', null],
    ],
  } as Partial<Block> & { kind: 'table' }),
  S({
    kind: 'metrics',
    items: [
      { label: 'MRR', value: 42000, prefix: '$', delta: 1200, vs: 'vs May', trend: [1, 3, 2, 4] },
      { label: 'Churn', value: 2.1, suffix: '%', delta: '+0.4%', good: 'down' },
    ],
  } as Partial<Block> & { kind: 'metrics' }),
  S({ kind: 'facts', items: [{ label: 'Owner', value: 'Dana' }] } as Partial<Block> & {
    kind: 'facts';
  }),
  S({
    kind: 'checklist',
    items: [
      { text: 'Domain', done: true },
      { text: 'DNS', done: false, note: 'waiting' },
    ],
  } as Partial<Block> & { kind: 'checklist' }),
  S({
    kind: 'steps',
    items: [
      { title: 'Build', status: 'done' },
      { title: 'Ship', status: 'current' },
      { title: 'Tell', status: 'todo' },
    ],
  } as Partial<Block> & { kind: 'steps' }),
  S({
    kind: 'links',
    items: [{ url: 'https://example.com/a', label: 'Spec', domain: 'example.com' }],
  } as Partial<Block> & { kind: 'links' }),
  S({ kind: 'callout', tone: 'warning', text: 'Prices change Monday.' } as Partial<Block> & {
    kind: 'callout';
  }),
  S({ kind: 'code', language: 'diff', code: '- a\n+ b' } as Partial<Block> & { kind: 'code' }),
];

describe('every kind', () => {
  it('draws from data, with its words', async () => {
    await draw(message(ALL, { intro: 'Here is the **week**.' }), replies().value);
    for (const words of [
      'Signups',
      'Trials',
      'Invoices',
      'Acme',
      '$1,200',
      'MRR',
      '$42K',
      '+$1,200',
      'vs May',
      'Churn',
      '+0.4%',
      'Owner',
      'Dana',
      '1 of 2 done',
      'waiting',
      'Build',
      'In progress',
      'Spec',
      'example.com',
      'Warning',
      'Prices change Monday.',
      '+ b',
      'Ads',
      '30%',
      '70%',
    ]) {
      expect(screen.getAllByText(words, { exact: false }).length).toBeGreaterThan(0);
    }
    expect(screen.getByTestId('chart-legend')).toBeTruthy();
    expect(screen.getByTestId('pie-legend')).toBeTruthy();
    expect(screen.getAllByTestId('metric-tile')).toHaveLength(2);
    expect(screen.getByTestId('callout-warning')).toBeTruthy();
  });

  it('says a chart with nothing in it has nothing to chart', async () => {
    await draw(
      message([
        S({
          kind: 'chart',
          chart: 'bar',
          labels: ['a'],
          series: [{ name: 'x', values: [null] }],
        } as Partial<Block> & { kind: 'chart' }),
      ]),
      null
    );
    expect(screen.getByText('Nothing to chart yet.')).toBeTruthy();
  });

  it('names a churn rise as bad: down is good there', async () => {
    await draw(message([ALL[3]!]), null);
    const tiles = screen.getAllByTestId('metric-tile');
    expect(tiles[1]!.props.accessibilityLabel).toContain('bad');
    expect(tiles[0]!.props.accessibilityLabel).toContain('good');
  });
});

describe('a table', () => {
  it('sorts by a header, numbers as numbers, blanks last', async () => {
    await draw(message([ALL[2]!]), null);
    const amounts = () =>
      screen.getAllByTestId('table-row').map((r) => {
        const texts: string[] = [];
        const walk = (n: unknown) => {
          if (typeof n === 'string') texts.push(n);
          else if (Array.isArray(n)) n.forEach(walk);
          else if (n && typeof n === 'object' && 'children' in n)
            walk((n as { children: unknown }).children);
        };
        walk(r.children);
        return texts.join('|');
      });
    await fireEvent.press(screen.getByTestId('table-head-1'));
    expect(amounts()[0]).toContain('$1,200');
    expect(amounts()[2]).toContain('–');
    await fireEvent.press(screen.getByTestId('table-head-1'));
    expect(amounts()[0]).toContain('$90');
    expect(amounts()[2]).toContain('–');
  });

  it('shows the first rows, then Show all', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => [`r${i}`, i]);
    await draw(
      message([
        S({
          kind: 'table',
          columns: [{ label: 'n' }, { label: 'v', numeric: true }],
          rows,
        } as Partial<Block> & { kind: 'table' }),
      ]),
      null
    );
    expect(screen.getAllByTestId('table-row')).toHaveLength(8);
    await fireEvent.press(screen.getByText('Show all 12 rows'));
    expect(screen.getAllByTestId('table-row')).toHaveLength(12);
  });
});

const CHOICES = S({
  kind: 'choices',
  question: 'Ship it?',
  options: [
    { label: 'Yes', reply: 'Yes, ship it.' },
    { label: 'Not yet', reply: 'Not yet' },
  ],
} as Partial<Block> & { kind: 'choices' });

describe('answers', () => {
  it('send a choice as the user’s words', async () => {
    const r = replies();
    await draw(message([CHOICES]), r.value);
    await fireEvent.press(screen.getByText('Yes'));
    expect(r.reply).toHaveBeenCalledWith('fin', 'Yes, ship it.', false);
    // Held still at once: a second tap sends nothing.
    await fireEvent.press(screen.getByText('Not yet'));
    expect(r.reply).toHaveBeenCalledTimes(1);
  });

  it('only stage the words from outside text, and say so', async () => {
    const r = replies();
    await draw(message([CHOICES], { fromOutside: true }), r.value);
    expect(screen.getByText(STAGED_NOTE)).toBeTruthy();
    await fireEvent.press(screen.getByText('Yes'));
    expect(r.reply).toHaveBeenCalledWith('fin', 'Yes, ship it.', true);
    expect(screen.getByText('In your message, ready for you to check and send.')).toBeTruthy();
  });

  it('hold still once answered, marking the one picked', async () => {
    const r = replies('yes, ship it.');
    await draw(message([CHOICES]), r.value);
    const buttons = screen.getAllByTestId('block-choice');
    expect(buttons[0]!.props.accessibilityState).toMatchObject({ selected: true });
    expect(buttons[1]!.props.accessibilityState).toMatchObject({ selected: false, disabled: true });
    await fireEvent.press(screen.getByText('Not yet'));
    expect(r.reply).not.toHaveBeenCalled();
  });

  it('are read-only where the chat can’t answer (a room)', async () => {
    await draw(message([CHOICES]), null);
    expect(screen.getAllByTestId('block-choice')[0]!.props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('pick an option of a comparison', async () => {
    const r = replies();
    await draw(
      message([
        S({
          kind: 'comparison',
          options: [
            {
              name: 'Vercel',
              pros: ['Fast'],
              cons: ['Cost'],
              recommended: true,
              reply: "Let's go with Vercel.",
            },
            { name: 'Netlify', pros: [], cons: [], reply: 'Netlify' },
          ],
        } as Partial<Block> & { kind: 'comparison' }),
      ]),
      r.value
    );
    expect(screen.getByText('Recommended')).toBeTruthy();
    await fireEvent.press(screen.getAllByTestId('comparison-pick')[1]!);
    expect(r.reply).toHaveBeenCalledWith('fin', 'Netlify', false);
  });
});

const FORM = S({
  kind: 'form',
  title: 'Event',
  submit: 'Book it',
  fields: [
    { id: 'where', label: 'Where', type: 'text', required: true },
    { id: 'people', label: 'People', type: 'number' },
    { id: 'plan', label: 'Plan', type: 'choice', options: ['Pro', 'Team'] },
    { id: 'notes', label: 'Notes', type: 'long_text' },
  ],
} as Partial<Block> & { kind: 'form' });

describe('a form', () => {
  it('asks for what it needs before sending, then sends one plain reply', async () => {
    const r = replies();
    await draw(message([FORM]), r.value);
    await fireEvent.press(screen.getByText('Book it'));
    expect(r.reply).not.toHaveBeenCalled();
    expect(screen.getByText('Fill in Where first.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('form-field-where'), 'Lisbon');
    await fireEvent.changeText(screen.getByTestId('form-field-people'), 'lots');
    await fireEvent.press(screen.getByText('Book it'));
    expect(r.reply).not.toHaveBeenCalled();
    expect(screen.getByText('A number, please')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('form-field-people'), '12');
    await fireEvent.press(screen.getByText('Team'));
    await fireEvent.press(screen.getByText('Book it'));
    expect(r.reply).toHaveBeenCalledWith(
      'fin',
      'Event\nWhere: Lisbon\nPeople: 12\nPlan: Team',
      false
    );
  });

  it('says Sent once answered, with nothing left to submit', async () => {
    await draw(message([FORM]), replies('Event\nWhere: Lisbon').value);
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.queryByText('Book it')).toBeNull();
  });
});

describe('the chat’s answers', () => {
  const m = (
    id: string,
    kind: AgentMessage['kind'],
    text: string,
    blocks?: boolean
  ): AgentMessage => ({
    id,
    agentId: 'a',
    ts: 0,
    kind,
    text,
    ...(blocks ? { blocks: { v: 1, items: [CHOICES] } } : {}),
  });

  it('are the user’s next message after each set, a send on its way included', async () => {
    const list = [
      m('1', 'agent', 'q1', true),
      m('2', 'user', 'Yes'),
      m('3', 'agent', 'q2', true),
      m('4', 'agent', 'more'),
    ];
    const got = blockAnswers(list);
    expect(got.get('1')).toBe('Yes');
    expect(got.has('3')).toBe(false);
    expect(blockAnswers(list, [{ text: 'Not yet' }]).get('3')).toBe('Not yet');
  });

  it('keeps blocks on a message from the Mac, and drops a set of the wrong shape', async () => {
    expect(asMessage({ id: 'x', blocks: { v: 1, items: [] } })?.blocks).toBeTruthy();
    expect(asMessage({ id: 'x', blocks: 'nope' })?.blocks).toBeUndefined();
  });
});
