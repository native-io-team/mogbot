import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ModalProvider } from '../../contexts/ModalContext';
import type { ImportTalk } from '../../lib/agents';
import { ImportConnectorPanel, talkLine } from './ImportConnectorPanel';
import { ImportTalkBar } from './ImportTalkBar';

let talk: ImportTalk | null = null;
const stopImportTalk = vi.fn(() => Promise.resolve(true));
vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  getImportPrompt: () => Promise.resolve('Move my agents to Dashbot. Use import_conversation.'),
  getImportTalk: () => Promise.resolve(talk),
  stopImportTalk: () => stopImportTalk(),
}));
vi.mock('../../lib/agentsStore', () => ({
  useAgentsList: () => [{ id: 'chief', name: 'Ada', isMain: true }],
}));

const TALK: ImportTalk = {
  id: 't',
  source: 'Grok',
  chiefId: 'chief',
  state: 'active',
  startedAt: 0,
  lastAt: 0,
  exchanges: 4,
  agents: ['Finance', 'Travel'],
};

function renderPanel(over: Partial<Parameters<typeof ImportConnectorPanel>[0]> = {}) {
  const props = {
    connected: true,
    onClose: vi.fn(),
    onOpenAgent: vi.fn(),
    onPaste: vi.fn(),
    ...over,
  };
  render(
    <ModalProvider>
      <ImportConnectorPanel {...props} />
    </ModalProvider>
  );
  return props;
}

describe('ImportConnectorPanel', () => {
  it('gives one message to send, says where to watch, and keeps pasting as the fallback', async () => {
    talk = null;
    const props = renderPanel();
    expect(await screen.findByText(/import_conversation/)).toBeInTheDocument();
    expect(screen.getByText('Watch it in Ada’s chat')).toBeInTheDocument();
    expect(screen.getByText(/Logins are asked for here, on secure cards/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Ada' }));
    expect(props.onOpenAgent).toHaveBeenCalledWith('chief');
    fireEvent.click(screen.getByRole('button', { name: 'Can’t connect? Paste a reply instead' }));
    expect(props.onPaste).toHaveBeenCalled();
  });

  it('asks for Remote access first when it is off', async () => {
    talk = null;
    renderPanel({ connected: false });
    expect(
      await screen.findByRole('button', { name: 'Set up Remote access…' })
    ).toBeInTheDocument();
  });

  it('shows the conversation going on, live', async () => {
    talk = TALK;
    renderPanel();
    expect(
      await screen.findByText('Ada is talking to Grok · Finance and Travel are here so far')
    ).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
  });
});

describe('talkLine', () => {
  it('says how far it got in each state', () => {
    expect(talkLine({ ...TALK, agents: [] }, 'Ada')).toBe('Ada is talking to Grok · no agents yet');
    expect(talkLine({ ...TALK, state: 'finished' }, 'Ada')).toBe(
      'Grok is done: 2 agents brought over'
    );
    expect(talkLine({ ...TALK, state: 'stopped' }, 'Ada')).toBe('You stopped the import from Grok');
  });
});

describe('ImportTalkBar', () => {
  it('shows only while a conversation is going, and stops it', async () => {
    talk = TALK;
    render(<ImportTalkBar chief="Ada" />);
    expect(await screen.findByText('Importing from Grok')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop import' }));
    expect(stopImportTalk).toHaveBeenCalled();
  });

  it('is gone when there is none', async () => {
    talk = { ...TALK, state: 'finished' };
    const { container } = render(<ImportTalkBar chief="Ada" />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });
});
