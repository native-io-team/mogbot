import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModalProvider } from '../../contexts/ModalContext';
import type { ImportGate, ImportTalk } from '../../lib/agents';
import { ImportConnectorPanel, talkLine } from './ImportConnectorPanel';
import { barLines, ImportTalkBar } from './ImportTalkBar';

let gate: ImportGate = { armed: false, talk: null };
const stopImportTalk = vi.fn(() => Promise.resolve(true));
const armImportTalk = vi.fn(() => Promise.resolve<ImportGate>({ armed: true, talk: null }));
vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  getImportPrompt: () => Promise.resolve('Move my agents. Use import_conversation.'),
  getImportTalk: () => Promise.resolve(gate),
  armImportTalk: () => armImportTalk(),
  stopImportTalk: () => stopImportTalk(),
}));
vi.mock('../../lib/agentsStore', () => ({
  useAgentsList: () => [{ id: 'chief', name: 'Ada', isMain: true }],
}));

const TALK: ImportTalk = {
  id: 't',
  source: 'Grok',
  chiefId: 'chief',
  state: 'interviewing',
  startedAt: 0,
  lastAt: 0,
  exchanges: 4,
  staged: ['Finance', 'Travel'],
  imported: [],
  busy: false,
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
  it('promises everything each agent does, played back first, and needs Start before the message', async () => {
    gate = { armed: false, talk: null };
    const props = renderPanel();
    // What it now does: everything each agent does, history as a bonus.
    expect(
      screen.getByText('Each agent’s instructions, routines and what it watches for')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Past conversations, if your assistant can send them')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Ada plays it back to you before anything is created/)
    ).toBeInTheDocument();
    // Honest: the other assistant decides what it can send.
    expect(
      screen.getByText('Your assistant chooses what it can send; you see what arrived')
    ).toBeInTheDocument();
    // The old promise is gone.
    expect(screen.queryByText(/can’t see your chats/i)).not.toBeInTheDocument();
    // No message to copy until Start.
    expect(screen.queryByText(/import_conversation/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(armImportTalk).toHaveBeenCalled();
    expect(await screen.findByText(/import_conversation/)).toBeInTheDocument();
    expect(screen.getByText('Allow it, then check the plan in Ada’s chat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Ada' }));
    expect(props.onOpenAgent).toHaveBeenCalledWith('chief');
    fireEvent.click(screen.getByRole('button', { name: 'Can’t connect? Paste a reply instead' }));
    expect(props.onPaste).toHaveBeenCalled();
  });

  it('can’t start without Remote access', async () => {
    gate = { armed: false, talk: null };
    renderPanel({ connected: false });
    expect(
      await screen.findByRole('button', { name: 'Set up Remote access…' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  it('shows the import going on, with Stop', async () => {
    gate = { armed: false, talk: TALK };
    renderPanel();
    expect(
      await screen.findByText('Grok is answering Ada’s questions · Finance and Travel staged')
    ).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop import' }));
    await waitFor(() => expect(stopImportTalk).toHaveBeenCalled());
  });
});

describe('talkLine', () => {
  it('says how far it got in each state, and never that anything was created before import', () => {
    expect(talkLine({ ...TALK, staged: [] }, 'Ada')).toBe('Grok is answering Ada’s questions');
    expect(talkLine({ ...TALK, state: 'awaiting_consent' }, 'Ada')).toBe(
      'Grok is asking to start: it needs your OK in Ada’s chat'
    );
    expect(talkLine({ ...TALK, state: 'review' }, 'Ada')).toBe(
      '2 agents ready for your review in Ada’s chat'
    );
    expect(talkLine({ ...TALK, state: 'imported', imported: ['Finance'] }, 'Ada')).toBe(
      'Imported Finance'
    );
    expect(talkLine({ ...TALK, state: 'stopped' }, 'Ada')).toBe(
      'You stopped the import from Grok. Nothing was created'
    );
  });
});

describe('ImportTalkBar', () => {
  it('shows while an import is going, says the interview is separate, and stops it', async () => {
    stopImportTalk.mockClear();
    gate = { armed: false, talk: TALK };
    render(<ImportTalkBar chief="Ada" />);
    expect(
      await screen.findByText('Importing from Grok · Finance and Travel staged for review')
    ).toBeInTheDocument();
    expect(screen.getByText(/what you type here stays between you and Ada/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stopImportTalk).toHaveBeenCalled();
  });

  it('is gone once it has ended', async () => {
    gate = { armed: false, talk: { ...TALK, state: 'imported' } };
    const { container } = render(<ImportTalkBar chief="Ada" />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('words each live state', () => {
    expect(barLines({ ...TALK, state: 'awaiting_consent' }, 'Ada').detail).toMatch(
      /Nothing has been shared/
    );
    expect(barLines({ ...TALK, state: 'review' }, 'Ada').detail).toMatch(
      /Nothing is created until you import/
    );
  });
});
