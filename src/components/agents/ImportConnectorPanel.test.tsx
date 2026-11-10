import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModalProvider } from '../../contexts/ModalContext';
import type { ImportGate, ImportTalk } from '../../lib/agents';
import { ImportConnectorPanel, talkLine } from './ImportConnectorPanel';
import { barLines, importCounts, ImportTalkBar } from './ImportTalkBar';

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
    fireEvent.click(
      screen.getByRole('button', { name: 'No Remote access? Use an export or paste a reply' })
    );
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
    // Ended by silence or a missing engine: never "you stopped it".
    expect(talkLine({ ...TALK, state: 'stopped', endedBy: 'idle' }, 'Ada')).toMatch(
      /^Grok went quiet for 30 minutes.*carry on with the import/
    );
    expect(talkLine({ ...TALK, state: 'stopped', endedBy: 'unavailable' }, 'Ada')).toMatch(
      /needs Claude Code/
    );
  });
});

describe('ImportTalkBar', () => {
  it('shows while an import is going, in one line of real counts, and stops it', async () => {
    stopImportTalk.mockClear();
    gate = { armed: false, talk: { ...TALK, conversations: 37, lastAt: Date.now() } };
    render(<ImportTalkBar />);
    expect(await screen.findByText('Importing from Grok')).toBeInTheDocument();
    expect(screen.getByText('2 agents staged · 37 conversations')).toBeInTheDocument();
    // The separate-conversation note is in the chat; the bar doesn't repeat it.
    expect(screen.queryByText(/can.t see your chats/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stopImportTalk).toHaveBeenCalled();
  });

  it('is gone once it has ended', async () => {
    gate = { armed: false, talk: { ...TALK, state: 'imported' } };
    const { container } = render(<ImportTalkBar />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('words each live state', () => {
    expect(barLines({ ...TALK, state: 'awaiting_consent' }).detail).toMatch(
      /Nothing has been shared/
    );
    expect(barLines({ ...TALK, state: 'review' }).detail).toMatch(
      /Nothing is created until you import/
    );
  });

  it('says when the other assistant has left the interview waiting, and the fix', () => {
    const at = 10 * 60_000;
    // Under three minutes, or while the interview itself is answering: not quiet.
    expect(barLines({ ...TALK, lastAt: at - 2 * 60_000 }, at).quiet).toBeUndefined();
    expect(barLines({ ...TALK, busy: true, lastAt: 0 }, at).quiet).toBeUndefined();
    const quiet = barLines({ ...TALK, lastAt: at - 4 * 60_000 }, at);
    expect(quiet.quiet).toBe(true);
    expect(quiet.title).toBe('Import from Grok · waiting on Grok');
    expect(quiet.detail).toBe(
      'Nothing from Grok for 4 min. In Grok, say “carry on with the import”.'
    );
    // Waiting on the user is never blamed on Grok.
    expect(barLines({ ...TALK, state: 'playback', lastAt: 0 }, at).quiet).toBeUndefined();
  });

  it('counts only what it has, never names or a percentage', () => {
    expect(importCounts({ ...TALK, staged: [] })).toBeNull();
    expect(importCounts({ ...TALK, staged: ['Finance'] })).toBe('1 agent staged');
    expect(importCounts({ ...TALK, staged: [], conversations: 1 })).toBe('1 conversation');
    expect(importCounts({ ...TALK, conversations: 1200 })).toBe(
      '2 agents staged · 1,200 conversations'
    );
  });
});
