import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportPastePanel } from './ImportPastePanel';
import type { ExportImportPreview } from '../../lib/agents';

const PREVIEW: ExportImportPreview = {
  source: 'Grok Bot',
  format: 'Pasted reply',
  verified: true,
  agents: [
    {
      name: 'Ledger',
      role: 'Bookkeeping',
      instructionsChars: 80,
      memoryLines: 2,
      routines: 1,
      watches: 0,
      apps: 1,
    },
  ],
  main: 'Atlas',
  about: [['People and contacts', 2]],
  problems: [],
  refused: [],
  gaps: ['Ledger: what it watches for'],
  followUp: 'Thanks. Some things are still missing:\n- Ledger: what it watches for',
  masked: 1,
  read: [],
  skipped: [],
};

const reviewText = vi.fn((_text: string) =>
  Promise.resolve({ chiefId: 'chief', requestId: 'r', agents: 1 })
);
let preview: ExportImportPreview = PREVIEW;

vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  getExportImportPrompt: () => Promise.resolve('Please send everything'),
  previewTextImport: () => Promise.resolve(preview),
  reviewTextImport: (text: string) => reviewText(text),
}));
vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  useAgentsList: () => [{ id: 'chief', name: 'Morgan', isMain: true }],
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));

describe('ImportPastePanel', () => {
  it('shows what a reply holds and asks for what is missing, then puts the card up', async () => {
    const onPosted = vi.fn();
    render(<ImportPastePanel onCancel={vi.fn()} onPosted={onPosted} />);
    const review = screen.getByRole('button', { name: 'Review in Morgan’s chat' });
    expect(review).toBeDisabled();
    fireEvent.change(screen.getByLabelText("The assistant's reply"), {
      target: { value: '```json\n{"agents":[{"name":"Ledger"}]}\n```' },
    });
    expect(
      await screen.findByText(/Still missing: Ledger: what it watches for/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Atlas was the main agent there/)).toBeInTheDocument();
    expect(screen.getByText(/1 password or key left out/)).toBeInTheDocument();
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);
    await waitFor(() =>
      expect(onPosted).toHaveBeenCalledWith(expect.objectContaining({ chiefId: 'chief' }))
    );
    expect(reviewText).toHaveBeenCalledWith('```json\n{"agents":[{"name":"Ledger"}]}\n```');
  });

  it('keeps Review off while the reply has problems', async () => {
    preview = { ...PREVIEW, problems: ['The JSON has a trailing comma at line 2.'] };
    render(<ImportPastePanel onCancel={vi.fn()} onPosted={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("The assistant's reply"), { target: { value: '{' } });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review in Morgan’s chat' })).toBeDisabled();
    preview = PREVIEW;
  });
});
