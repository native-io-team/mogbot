import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModalProvider } from '../../contexts/ModalContext';
import { ImportAgentsModal } from './ImportAgentsModal';
import type { ImportResult } from './ImportPastePanel';

vi.mock('../../lib/remoteAccess', () => ({
  getRemoteAccessStatus: () => Promise.resolve({ enabled: remoteOn }),
}));
vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  getImportPrompt: () => Promise.resolve('prompt'),
  getImportTalk: () => Promise.resolve(null),
  previewOtherAppImport: () => Promise.resolve(other()),
}));
vi.mock('../../lib/agentsStore', () => ({
  useAgentsList: () => [{ id: 'chief', name: 'Chief of Staff', isMain: true }],
}));
vi.mock('./ImportParts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ImportParts')>()),
  ImportDone: () => <p>Imported</p>,
}));

let other: () => unknown = () => null;
let remoteOn = false;

const RESULT: ImportResult = {
  summary: { created: ['Finance'], updated: [], skipped: [], routinesSet: [], routinesRefused: [] },
  agents: [],
};

// What the other app's panel shows is its own test's business; here only
// where it sits, and one button that finishes it.
vi.mock('./OtherAppImportPanel', () => ({
  OtherAppImportPanel: ({ onDone }: { onDone: (r: ImportResult) => void }) => (
    <>
      <p>The other app’s agents</p>
      <button type="button" onClick={() => onDone(RESULT)} onKeyDown={() => onDone(RESULT)}>
        Finish
      </button>
    </>
  ),
}));

// The export and paste panel's whole job here: put the card up, with its way back.
vi.mock('./ImportPastePanel', () => ({
  ImportPastePanel: ({
    onPosted,
    aside,
  }: {
    onPosted: (p: { chiefId: string; requestId: string; agents: number }) => void;
    aside?: ReactNode;
  }) => (
    <>
      {aside}
      <button
        type="button"
        onClick={() => onPosted({ chiefId: 'chief', requestId: 'r', agents: 2 })}
      >
        Review
      </button>
    </>
  ),
}));

const OTHER = {
  appName: 'Elsewhere',
  agents: [],
  totalBytes: 0,
  sameVolume: true,
  enoughSpace: true,
};

async function renderModal() {
  other = () => OTHER;
  render(
    <ModalProvider>
      <ImportAgentsModal isOpen onClose={vi.fn()} onOpenAgent={vi.fn()} initialPath="otherApp" />
    </ModalProvider>
  );
  return screen.findByRole('button', { name: 'Finish' });
}

describe('ImportAgentsModal paths', () => {
  it('without Remote access, opens on an export or a paste, and the card opens the Chief', async () => {
    other = () => null;
    remoteOn = false;
    const openAgent = vi.fn();
    render(
      <ModalProvider>
        <ImportAgentsModal isOpen onClose={vi.fn()} onOpenAgent={openAgent} />
      </ModalProvider>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(openAgent).toHaveBeenCalledWith('chief');
    fireEvent.click(
      screen.getByRole('button', { name: 'Connect your assistant over Remote access instead' })
    );
    expect(await screen.findByText('Start, then send it a message')).toBeInTheDocument();
  });

  it('with Remote access, leads with the conversation, the export or paste one link away', async () => {
    other = () => null;
    remoteOn = true;
    render(
      <ModalProvider>
        <ImportAgentsModal isOpen onClose={vi.fn()} onOpenAgent={vi.fn()} />
      </ModalProvider>
    );
    expect(await screen.findByText('Start, then send it a message')).toBeInTheDocument();
    // No other app here: no segments, one path.
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'No Remote access? Use an export or paste a reply' })
    );
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
    remoteOn = false;
  });

  it('names the other app’s segment from its preview', async () => {
    other = () => ({
      appName: 'Elsewhere',
      agents: [],
      totalBytes: 0,
      sameVolume: true,
      enoughSpace: true,
    });
    render(
      <ModalProvider>
        <ImportAgentsModal isOpen onClose={vi.fn()} onOpenAgent={vi.fn()} />
      </ModalProvider>
    );
    expect(await screen.findByRole('tab', { name: 'From Elsewhere' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'From another assistant' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    other = () => null;
  });

  it('puts another assistant first, and opens there even with agents left in the other app', async () => {
    other = () => ({
      appName: 'Elsewhere',
      agents: [{ id: 'a', name: 'Scout', plan: 'new' }],
      totalBytes: 0,
      sameVolume: true,
      enoughSpace: true,
    });
    render(
      <ModalProvider>
        <ImportAgentsModal isOpen onClose={vi.fn()} onOpenAgent={vi.fn()} />
      </ModalProvider>
    );
    await screen.findByRole('tab', { name: 'From Elsewhere' });
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['From another assistant', 'From Elsewhere']);
    expect(screen.getByRole('tab', { name: 'From another assistant' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    other = () => null;
  });

  it('opens on the other app only when asked for it', async () => {
    other = () => ({
      appName: 'Elsewhere',
      agents: [],
      totalBytes: 0,
      sameVolume: true,
      enoughSpace: true,
    });
    render(
      <ModalProvider>
        <ImportAgentsModal isOpen onClose={vi.fn()} onOpenAgent={vi.fn()} initialPath="otherApp" />
      </ModalProvider>
    );
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'From Elsewhere' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    );
    other = () => null;
  });
});

describe('ImportAgentsModal done state', () => {
  it('opens quiet after a pointer import: focus on the body, not the button', async () => {
    const finish = await renderModal();
    act(() => {
      fireEvent.click(finish, { detail: 1 });
    });
    const open = screen.getByRole('button', { name: 'Open Chief of Staff' });
    expect(open).not.toHaveFocus();
    expect(screen.getByText('Imported').closest('.agents-import__body')).toHaveFocus();
  });

  it('focuses Open after a keyboard import', async () => {
    const finish = await renderModal();
    act(() => {
      fireEvent.keyDown(finish, { key: 'Enter' });
    });
    expect(screen.getByRole('button', { name: 'Open Chief of Staff' })).toHaveFocus();
  });
});
