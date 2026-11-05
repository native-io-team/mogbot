import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OtherAppAgent, OtherAppPreview, OtherAppSummary } from '../../lib/agents';
import { OtherAppImportPanel } from './OtherAppImportPanel';
import type { ImportResult } from './ImportPastePanel';

const importFromOtherApp = vi.fn<() => Promise<OtherAppSummary>>();
vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  importFromOtherApp: () => importFromOtherApp(),
}));
vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  useAgentsList: () => [{ id: 'chief', name: 'Chief of Staff', isMain: true }],
}));

const agent = (over: Partial<OtherAppAgent>): OtherAppAgent => ({
  sourceId: 'x',
  name: 'X',
  role: '',
  color: 'gray',
  isMain: false,
  plan: 'new',
  instructions: '',
  memory: [],
  messages: 0,
  attachments: 0,
  routines: [],
  secrets: [],
  projectMissing: false,
  ...over,
});

const PREVIEW: OtherAppPreview = {
  appName: 'Other',
  agents: [
    agent({ sourceId: 'c', name: 'Chief of Staff', isMain: true, plan: 'merge', messages: 3 }),
    agent({
      sourceId: 'f',
      name: 'Finance',
      secrets: ['Stripe key'],
      routines: [{ schedule: 'every 2 hours', what: 'x' }],
    }),
    agent({ sourceId: 'r', name: 'Research', plan: 'imported', reason: 'Already brought over.' }),
  ],
};

describe('OtherAppImportPanel', () => {
  it('counts only who will come across, and says what stays behind before importing', () => {
    render(<OtherAppImportPanel preview={PREVIEW} onCancel={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Import 2 agents' })).toBeEnabled();
    expect(screen.getByText(/credentials aren’t copied between apps/)).toBeInTheDocument();
    expect(screen.getByText(/1 routine will arrive paused/)).toBeInTheDocument();
    expect(screen.getByText('Already here')).toBeInTheDocument();
  });

  it('has nothing to import when everyone is already here', () => {
    const done = { ...PREVIEW, agents: [PREVIEW.agents[2]] };
    render(<OtherAppImportPanel preview={done} onCancel={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Nothing to import' })).toBeDisabled();
  });

  it('hands the summary and the arriving agents to the done state', async () => {
    const summary: OtherAppSummary = {
      created: ['Finance'],
      updated: ['Chief of Staff'],
      skipped: [],
      routinesSet: [],
      routinesRefused: [],
      appName: 'Other',
      already: ['Research'],
      routinesPaused: 1,
      messages: 3,
      secretsLeft: [{ agent: 'Finance', secrets: ['Stripe key'] }],
      filesSkipped: [],
    };
    importFromOtherApp.mockResolvedValue(summary);
    const onDone = vi.fn<(r: ImportResult) => void>();
    render(<OtherAppImportPanel preview={PREVIEW} onCancel={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 agents' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.summary).toBe(summary);
    expect(result.agents.map((a) => a.name)).toEqual(['Chief of Staff', 'Finance']);
  });
});
