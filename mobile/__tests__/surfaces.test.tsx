/**
 * Lines, cards and bars (`components/surfaces.tsx`): every card in the chat
 * has the same anatomy in the same order, its single affirmative last and
 * neutral; bars stack in one fixed order, two at a time; a usage limit is a
 * line and a real failure a card.
 */

import type { AgentMessage, Approval, SecretRequest } from '@shipstudio/companion-protocol';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { ApprovalCard, ARM_MS } from '../src/components/ApprovalCard';
import { MessageRow } from '../src/components/chat';
import { ConversationBars } from '../src/components/ConversationBars';
import { CopyCard } from '../src/components/copy';
import { SecretCard } from '../src/components/SecretCard';
import { BarStack, barTint, Card, stackBars, type BarSpec } from '../src/components/surfaces';
import { Button, T } from '../src/components/ui';
import { answerAccent } from '../src/lib/accent';
import { BAR_ORDER, importBar, MAX_BARS } from '../src/lib/bars';
import { useApp } from '../src/lib/store';
import { agentTints, APPEARANCES, palettes } from '../src/lib/theme';
import { agent, msg } from './helpers';

jest.mock('react-native-reanimated', () => {
  const { View, FlatList } = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  for (const k of ['duration', 'delay', 'springify', 'damping']) preset[k] = () => preset;
  return {
    __esModule: true,
    default: { View, FlatList },
    FadeIn: preset,
    FadeInDown: preset,
    FadeOut: preset,
    ZoomIn: preset,
    ZoomOut: preset,
    LinearTransition: preset,
  };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-haptics', () => ({}));
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
  answerApproval: jest.fn(),
  keepCopy: jest.fn(),
  discardCopy: jest.fn(),
  saveSecret: jest.fn(),
  currentTransport: () => ({ route: 'tailscale' }),
  secretRouteProblem: () => null,
  describeError: String,
  discardPending: jest.fn(),
  editPending: jest.fn(),
  send: jest.fn(),
}));

/** The card's parts, in the order they're drawn. */
interface Node {
  type: unknown;
  props: Record<string, unknown>;
  children: (Node | string)[];
}
function partOrder(root: Node | null): string[] {
  const order: string[] = [];
  const walk = (node: Node) => {
    const id = node.props?.testID as string | undefined;
    if (typeof node.type === 'string' && id && !order.includes(id)) order.push(id);
    for (const child of node.children) if (typeof child !== 'string') walk(child);
  };
  if (root) walk(root);
  return order;
}

/** The answers in the card's row, left to right. */
const answers = () =>
  screen
    .getAllByRole('button')
    .map((b) => b.props.accessibilityLabel as string)
    .filter(Boolean);

/** Whether a button is filled with the neutral answer colour, in either appearance. */
function isNeutralAnswer(label: string): boolean {
  const button = screen.getAllByRole('button').find((b) => b.props.accessibilityLabel === label)!;
  const style = button.props.style as StyleProp<ViewStyle>;
  const bg = StyleSheet.flatten(style)?.backgroundColor;
  return APPEARANCES.some((a) => answerAccent(a).accent === bg);
}

describe('a card', () => {
  it('is icon and title, source, body, note, then the answers, in that order', async () => {
    const view = await render(
      <Card
        icon="checkmark.shield"
        title="Run a command"
        source="Acme Site · in acme-site"
        note="It paused here for you."
        actions={
          <>
            <Button title="Deny" variant="outline" />
            <Button title="Allow" variant="answer" />
          </>
        }
      >
        <T testID="card-body">npm test</T>
      </Card>
    );
    expect(partOrder(view.root)).toEqual([
      'card-head',
      'card-source',
      'card-body',
      'card-note',
      'card-actions',
    ]);
    expect(answers()).toEqual(['Deny', 'Allow']);
    expect(screen.getByRole('header').props.children).toBe('Run a command');
  });
});

describe('every request card', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useApp.setState({
      link: { kind: 'connected' } as never,
      welcome: { methods: ['agents.keepCopy'] } as never,
      projects: [] as never,
    });
  });
  afterEach(() => jest.useRealTimers());

  const approval: Approval = {
    requestId: 'r1',
    title: 'Run a command',
    detail: 'npm test',
    status: 'pending',
    always: { kind: 'command_prefix', label: 'npm test' } as never,
  };
  const message = { ...msg('m1', 1), kind: 'approval', approval } as AgentMessage;

  it('approval: ⋯ · Deny · Allow, the neutral Allow last', async () => {
    const view = await render(
      <ApprovalCard message={message} approval={approval} agent={agent()} onError={() => {}} />
    );
    await act(() => jest.advanceTimersByTime(ARM_MS + 50));
    expect(answers()).toEqual(['More answers', 'Deny', 'Allow']);
    expect(isNeutralAnswer('Allow')).toBe(true);
    expect(isNeutralAnswer('Deny')).toBe(false);
    // Idle with it open: "It paused here for you" is the note, before the answers.
    expect(partOrder(view.root).filter((p) => p.startsWith('card-'))).toEqual([
      'card-head',
      'card-note',
      'card-actions',
    ]);
    // No amber "NEEDS YOUR OK" eyebrow on the card: the row and the bar say it.
    expect(screen.queryByText('NEEDS YOUR OK')).toBeNull();
  });

  it('import consent: Deny · Allow, no note to send instead', async () => {
    const consent: Approval = {
      ...approval,
      always: undefined,
      title: 'Grok wants to bring its agents over',
      detail: '',
      connector: { kind: 'consent', talkId: 't', source: 'Grok' },
    };
    await render(
      <ApprovalCard
        message={{ ...message, approval: consent }}
        approval={consent}
        agent={agent()}
        onError={() => {}}
      />
    );
    await act(() => jest.advanceTimersByTime(ARM_MS + 50));
    expect(answers()).toEqual(['Deny', 'Allow']);
  });

  it('secret: the fields, the note, then Deny · Save with Save neutral', async () => {
    const request: SecretRequest = {
      name: 'Stripe key',
      purpose: 'To check last month’s payouts',
      fields: [{ env: 'STRIPE_KEY', label: 'Secret key' }],
    } as SecretRequest;
    const secret = { ...approval, always: undefined, secret: request };
    const view = await render(
      <SecretCard
        message={{ ...message, approval: secret }}
        approval={secret}
        request={request}
        agent={agent()}
        onError={() => {}}
      />
    );
    await act(() => jest.advanceTimersByTime(ARM_MS + 50));
    expect(answers()).toEqual(['Deny', 'Save']);
    await fireEvent.changeText(screen.getByLabelText('Secret key'), 'sk_live_x');
    expect(isNeutralAnswer('Save')).toBe(true);
    expect(partOrder(view.root).filter((p) => p.startsWith('card-'))).toEqual([
      'card-head',
      'card-source',
      'card-note',
      'card-actions',
    ]);
  });

  it('copy: Discard · Keep changes, Keep neutral, and held while it’s driven on the Mac', async () => {
    const COPY = { id: 'c', path: '/x', branch: 'a/x' };
    const withCopy = (over = {}) =>
      agent({
        copy: { ...COPY, project: '/p/acme', base: 'b', createdAt: 1, deps: true },
        ...over,
      } as never);
    const view = await render(
      <CopyCard agent={withCopy()} copy={COPY} project="/p/acme" onError={() => {}} />
    );
    expect(answers()).toEqual(['Discard', 'Keep changes']);
    expect(isNeutralAnswer('Keep changes')).toBe(true);
    await view.rerender(
      <CopyCard
        agent={withCopy({ takeover: { since: 1, cli: 'claude-code' } })}
        copy={COPY}
        project="/p/acme"
        onError={() => {}}
      />
    );
    const keep = screen
      .getAllByRole('button')
      .find((b) => b.props.accessibilityLabel === 'Keep changes');
    const state = keep!.props.accessibilityState as { disabled?: boolean };
    expect(state.disabled).toBe(true);
    expect(screen.getByText(/hand it back first/)).toBeTruthy();
  });
});

describe('errors in the chat', () => {
  it('a usage limit is a line, not a card', async () => {
    const m = {
      ...msg('e1', 1),
      kind: 'error',
      text: '',
      failure: { kind: 'usage_limit', resetsAt: 0 },
    } as AgentMessage;
    await render(<MessageRow message={m} agent={agent()} queued={false} onError={() => {}} />);
    expect(screen.getByTestId('line')).toBeTruthy();
    expect(screen.queryByTestId('card-head')).toBeNull();
  });

  it('a real failure is a card with the error mark', async () => {
    const m = {
      ...msg('e2', 1),
      kind: 'error',
      text: 'The tool crashed.',
      failure: { kind: 'other' },
    } as AgentMessage;
    await render(<MessageRow message={m} agent={agent()} queued={false} onError={() => {}} />);
    expect(screen.getByTestId('card-head')).toBeTruthy();
    expect(screen.getByText('Didn’t finish: The tool crashed')).toBeTruthy();
  });

  it('a real failure says where it ran and, if it ended the last turn, what to do', async () => {
    const m = {
      ...msg('e3', 1),
      kind: 'error',
      text: '',
      failure: { kind: 'signed_out' },
    } as AgentMessage;
    await render(
      <MessageRow message={m} agent={agent()} queued={false} latestFailure onError={() => {}} />
    );
    // Not the engine: the message doesn't record it, and the agent may have switched.
    expect(screen.getByTestId('card-source').props.children).toBe('In site');
    expect(screen.getByTestId('card-note')).toBeTruthy();
    expect(screen.getByLabelText('Connection details')).toBeTruthy();
  });

  it("an older failure doesn't tell you to try again", async () => {
    const m = { ...msg('e4', 1), kind: 'error', text: 'Crashed', failure: { kind: 'other' } };
    await render(
      <MessageRow message={m as AgentMessage} agent={agent()} queued={false} onError={() => {}} />
    );
    expect(screen.queryByTestId('card-note')).toBeNull();
  });

  it('one agent writing to another is set off from the reply, not a line of prose', async () => {
    const m = {
      ...msg('p1', 1),
      kind: 'sent_to_agent',
      text: 'File these',
      peer: { id: 'ops', name: 'Ops' },
    } as AgentMessage;
    await render(<MessageRow message={m} agent={agent()} queued={false} onError={() => {}} />);
    expect(screen.getByTestId('peer-row')).toBeTruthy();
    expect(screen.getByText('To Ops')).toBeTruthy();
    expect(screen.getByText('File these')).toBeTruthy();
  });

  it('a note (started fresh, a take-over that closed) is a line', async () => {
    const m = {
      ...msg('n1', 1),
      kind: 'note',
      text: 'Started fresh · memory kept',
      fresh: true,
    } as AgentMessage;
    await render(<MessageRow message={m} agent={agent()} queued={false} onError={() => {}} />);
    expect(screen.getByTestId('line')).toBeTruthy();
  });
});

describe('bars above the composer', () => {
  const spec = (id: BarSpec['id']): BarSpec => ({ id, tone: 'info', title: id });

  it('stack in the fixed order, two at a time, the rest folded', () => {
    const all = [...BAR_ORDER].reverse().map(spec);
    const { shown, folded } = stackBars(all);
    expect(shown.map((b) => b.id)).toEqual(BAR_ORDER.slice(0, MAX_BARS));
    expect(folded).toBe(BAR_ORDER.length - MAX_BARS);
    expect(stackBars(all, true).shown.map((b) => b.id)).toEqual([...BAR_ORDER]);
  });

  it('say "N more", and open to all of them', async () => {
    await render(<BarStack bars={[spec('engine'), spec('import'), spec('driven')]} />);
    expect(screen.getByTestId('bar-driven')).toBeTruthy();
    expect(screen.getByTestId('bar-import')).toBeTruthy();
    expect(screen.queryByTestId('bar-engine')).toBeNull();
    await fireEvent.press(screen.getByLabelText('1 more'));
    expect(screen.getByTestId('bar-engine')).toBeTruthy();
  });

  it('driven on the Mac and asking for changes: both bars, in that order, and changes can be dropped', async () => {
    useApp.setState({ link: { kind: 'connected' } as never, chats: {} });
    const drop = jest.fn();
    const view = await render(
      <ConversationBars
        agent={agent({ takeover: { since: 1, cli: 'claude-code' } } as never)}
        revising={{ id: 'r', version: 2, title: 'Brief' }}
        onStopRevising={drop}
      />
    );
    expect(partOrder(view.root).filter((p) => p.startsWith('bar-'))).toEqual([
      'bar-driven',
      'bar-revising',
    ]);
    expect(screen.getByText('Changes to Brief · v2')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Don't ask for changes"));
    expect(drop).toHaveBeenCalled();
  });

  it('take their colour from status roles, never an agent’s accent', () => {
    for (const a of APPEARANCES) {
      const accents = new Set([...Object.values(agentTints[a]), palettes[a].accentNeutral]);
      for (const [tone, hex] of Object.entries(barTint(palettes[a]))) {
        expect([a, tone, accents.has(hex)]).toEqual([a, tone, false]);
      }
    }
  });

  it('an import ready to review says the state in one line, not the card’s sentence again', () => {
    const review = {
      ...msg('v', 1),
      kind: 'approval',
      approval: {
        requestId: 'r',
        title: 'Review the import from Grok',
        detail: '',
        status: 'pending',
        connector: { kind: 'review', talkId: 't', source: 'Grok' },
      },
    } as AgentMessage;
    const bar = importBar(agent(), [review])!;
    expect(bar.title).toBe('Import from Grok · waiting on your Mac');
    expect(bar.detail).toBeUndefined();
  });

  it('an import says its state, never the request’s question or "the card"', () => {
    const consent = {
      ...msg('c', 1),
      kind: 'approval',
      approval: {
        requestId: 'r',
        title: 'Grok wants to bring its agents over',
        detail: '',
        status: 'pending',
        connector: { kind: 'consent', talkId: 't', source: 'Grok' },
      },
    } as AgentMessage;
    const bar = importBar(agent(), [consent])!;
    expect(bar.title).toBe('Import from Grok · Needs your OK');
    expect(bar.title).not.toContain('wants to bring');
    expect(`${bar.title} ${bar.detail}`).not.toMatch(/card/i);
    const going = importBar(
      agent({ status: { state: 'working', activity: 'Bringing in agents from Grok', since: 1 } }),
      []
    )!;
    expect(going.title).toBe('Importing from Grok');
    // One line, led by the typing dots; the chat's note says the rest.
    expect(going.live).toBe(true);
    expect(going.detail).toBeUndefined();
    expect(importBar(agent(), [])).toBeNull();
  });
});
