import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ApprovalCard } from './AgentChatItems';
import type { AgentMessage, Approval } from '../../lib/agents';
import { PairConfirm } from '../phone/PhonePairing';
import type { Device, PairRequestView } from '../../lib/companion';
import editorSource from './AgentEditorModal.tsx?raw';
import chatItemsSource from './AgentChatItems.tsx?raw';
import remoteSource from '../remote/RemoteAccessModal.tsx?raw';

/**
 * The owner's rule: an answer on an approval or prompt card is never the
 * accent. The accent is whatever colour the user (or the agent) picked — red
 * is in the palette — and a red Allow reads as the destructive choice.
 */

const base: Approval = {
  requestId: 'r1',
  title: 'Run a command',
  detail: 'npm test',
  status: 'pending',
};

const message = (approval: Approval): AgentMessage => ({
  id: 'm1',
  agentId: 'acme',
  ts: Date.now(),
  kind: 'approval',
  text: '',
  approval,
});

const cards: [string, Approval][] = [
  ['approval', base],
  [
    'approval with Always allow',
    { ...base, always: { kind: 'command_prefix', value: 'npm', label: 'npm' } },
  ],
  [
    'session prompt',
    {
      ...base,
      prompt: {
        kind: 'choice',
        project: '/Users/me/ShipStudio/site',
        sessionId: 's1',
        tab: 1,
        question: 'Proceed?',
        options: [
          { label: 'Yes', keys: ['1'], role: 'allow' },
          { label: 'Yes, and don’t ask again', keys: ['2'], role: 'other' },
          { label: 'No', keys: ['3'], role: 'deny' },
        ],
        owner: { id: 'acme', name: 'Acme' },
        chats: ['acme'],
      },
    },
  ],
  [
    'secret request',
    {
      ...base,
      title: 'Secure input · key',
      secret: {
        name: 'key',
        purpose: 'Pull payouts',
        kind: 'api_key',
        fields: [{ label: 'API key', env: 'KEY' }],
        reference: 'secret:acme/key',
      },
    },
  ],
];

describe('the phone pairing and the editor answer neutrally too', () => {
  const request = (replaces: Device[]): PairRequestView => ({
    id: 'p1',
    device: { name: 'Sam’s iPhone', platform: 'ios', appVersion: '1.0', build: 'official' },
    requestedAt: Date.now(),
    codeHint: 'AB12',
    replaces,
  });
  const paired = {
    id: 'd1',
    name: 'Sam’s iPhone',
    platform: 'ios',
    appVersion: '1.0',
    build: 'official',
    pairedAt: Date.now(),
  } as unknown as Device;
  for (const [name, replaces] of [
    ['allow a phone', []],
    ['allow and replace a phone', [paired]],
  ] as const) {
    it(`${name}: Allow is strong, never the accent`, () => {
      const { container } = render(
        <PairConfirm request={request([...replaces])} busy={null} onDecide={vi.fn()} />
      );
      for (const button of container.querySelectorAll('button')) {
        expect(button.className, button.textContent ?? '').not.toMatch(/button--primary/);
      }
      const allow = container.querySelector('[data-allow]');
      expect(allow).not.toBeNull();
      expect(allow!.className).toMatch(/button--strong/);
    });
  }

  it('the editor’s “Keep changes” (moving an agent with an open copy) is strong', () => {
    // The <Button …> that ends in "Keep changes": its props are what's between.
    const end = editorSource.indexOf('Keep changes\n');
    expect(end, 'the rebind prompt offers Keep changes').toBeGreaterThan(0);
    const button = editorSource.slice(editorSource.lastIndexOf('<Button', end), end);
    expect(button).toMatch(/data-allow/);
    expect(button).toMatch(/variant="strong"/);
    expect(button).not.toMatch(/variant="primary"/);
  });
});

describe('approval and prompt answers are neutral', () => {
  for (const [name, approval] of cards) {
    it(`${name}: no answer button takes the accent`, () => {
      const { container } = render(
        <ApprovalCard
          message={message(approval)}
          agentName="Acme"
          paused={false}
          onAnswer={vi.fn()}
        />
      );
      const buttons = [...container.querySelectorAll('button')];
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.className, button.textContent ?? '').not.toMatch(/button--primary/);
      }
      const allow = container.querySelector('[data-allow]');
      expect(allow, 'the affirmative answer is marked').not.toBeNull();
      expect(allow!.className).toMatch(/button--strong/);
    });
  }
});

describe('an action inside a status is neutral, never the accent', () => {
  // The accent is the Chief's colour and means primary action; a retry in an
  // alert is not that.
  const cases: [string, string, string][] = [
    ['“Try again” in the “Not sent.” alert', chatItemsSource, 'Try again\n'],
    [
      'the phone link in Remote access’s intro',
      remoteSource,
      'On your phone, the phone app is simpler.\n',
    ],
  ];
  for (const [name, source, label] of cases) {
    it(name, () => {
      const end = source.indexOf(label);
      expect(end, label).toBeGreaterThan(0);
      const button = source.slice(source.lastIndexOf('<TextButton', end), end);
      expect(button).toMatch(/variant="strong"/);
      expect(button).not.toMatch(/variant="accent"/);
    });
  }
});

describe('a session’s permission card body', () => {
  const permission = (detail: string): Approval => ({
    ...base,
    title: 'Do you want to proceed?',
    detail,
    prompt: {
      kind: 'permission',
      project: '/Users/me/ShipStudio/site',
      sessionId: 's1',
      tab: 1,
      question: 'Do you want to proceed?',
      options: [
        { label: 'Yes', keys: ['1'], role: 'allow' },
        { label: 'No', keys: ['2'], role: 'deny' },
      ],
      owner: { id: 'acme', name: 'Acme' },
      chats: ['acme'],
    },
  });
  const body = (detail: string) => {
    const { container } = render(
      <ApprovalCard
        message={message(permission(detail))}
        agentName="Acme"
        paused={false}
        onAnswer={vi.fn()}
      />
    );
    return container;
  };

  it('keeps a one-line command as code', () => {
    const container = body('rm -rf build');
    expect(container.querySelector('pre')?.textContent).toBe('rm -rf build');
  });

  it('says an edit as a sentence', () => {
    const container = body('Edit index.html');
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).toContain('Edit index.html');
  });
});
