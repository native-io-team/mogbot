import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OtherAppAgent, OtherAppPreview, OtherAppSummary } from '../../lib/agents';
import { DoneExtra, formatBytes, importLabel, OtherAppImportPanel } from './OtherAppImportPanel';
import type { ImportResult } from './ImportPastePanel';

const importFromOtherApp = vi.fn<(o: { keepRules: boolean }) => Promise<OtherAppSummary>>();
const loadMessages = vi.fn<(id: string) => Promise<void>>();
vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  importFromOtherApp: (o: { keepRules: boolean }) => importFromOtherApp(o),
}));
vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  useAgentsList: () => [{ id: 'chief', name: 'Ada', isMain: true }],
  loadMessages: (id: string) => loadMessages(id),
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
  rules: [],
  bytes: 1024,
  projectMissing: false,
  ...over,
});

const PREVIEW: OtherAppPreview = {
  appName: 'Other',
  totalBytes: 2048,
  sameVolume: true,
  enoughSpace: true,
  agents: [
    agent({
      sourceId: 'c',
      name: 'Chief of Staff',
      isMain: true,
      plan: 'merge',
      messages: 3,
      rules: ['npm test'],
    }),
    agent({
      sourceId: 'f',
      name: 'Finance',
      secrets: ['Stripe key'],
      routines: [{ schedule: 'every 2 hours', what: 'x' }],
      project: '/Users/you/ShipStudio/books',
      rules: ['git push'],
    }),
    agent({ sourceId: 'r', name: 'Research', plan: 'imported', reason: 'Already brought over.' }),
  ],
};

const SUMMARY: OtherAppSummary = {
  created: ['Finance'],
  updated: ['Ada'],
  skipped: [],
  routinesSet: [],
  routinesRefused: [],
  appName: 'Other',
  already: ['Research'],
  routinesPaused: 1,
  messages: 3,
  secretsLeft: [{ agent: 'Finance', secrets: ['Stripe key'] }],
  rulesKept: [],
  rulesLeft: [{ agent: 'Ada', rules: ['npm test'] }],
  filesSkipped: [],
};

describe('OtherAppImportPanel', () => {
  it('counts the merge apart from new agents, and says what stays behind before importing', () => {
    render(<OtherAppImportPanel preview={PREVIEW} onCancel={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Import 1 agent and merge' })).toBeEnabled();
    expect(screen.getByText(/1 new, 1 merges into Ada/)).toBeInTheDocument();
    expect(screen.getByText('Merges into Ada')).toBeInTheDocument();
    expect(screen.getByText(/credentials aren’t copied between apps/)).toBeInTheDocument();
    expect(screen.getByText(/copies in Other keep running/)).toBeInTheDocument();
    expect(screen.getByText(/same project folder as Other’s copy/)).toBeInTheDocument();
    expect(screen.getByText(/Ada from a recap/)).toBeInTheDocument();
    expect(screen.getByText('Already here')).toBeInTheDocument();
  });

  it('lists an agent’s rules in its detail and leaves them behind unless kept', async () => {
    importFromOtherApp.mockResolvedValue(SUMMARY);
    render(<OtherAppImportPanel preview={PREVIEW} onCancel={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByText('Finance'));
    expect(screen.getByText('Always allow rules')).toBeInTheDocument();
    expect(screen.getByText('git push')).toBeInTheDocument();
    const keep = screen.getByRole('checkbox', { name: 'Keep their “Always allow” rules' });
    expect(keep).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 agent and merge' }));
    await waitFor(() => expect(importFromOtherApp).toHaveBeenLastCalledWith({ keepRules: false }));
    fireEvent.click(keep);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 agent and merge' }));
    await waitFor(() => expect(importFromOtherApp).toHaveBeenLastCalledWith({ keepRules: true }));
  });

  it('refuses a copy that would not fit, and names the sizes', () => {
    const big = {
      ...PREVIEW,
      sameVolume: false,
      enoughSpace: false,
      totalBytes: 3 * 2 ** 30,
      freeBytes: 2 ** 30,
    };
    render(<OtherAppImportPanel preview={big} onCancel={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('needs 3.0 GB and 1.0 GB is free');
    expect(screen.getByRole('button', { name: 'Import 1 agent and merge' })).toBeDisabled();
  });

  it('has nothing to import when everyone is already here', () => {
    const done = { ...PREVIEW, agents: [PREVIEW.agents[2]] };
    render(<OtherAppImportPanel preview={done} onCancel={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Nothing to import' })).toBeDisabled();
    expect(screen.getByText(/all already here/)).toBeInTheDocument();
  });

  it('hands the summary to the done state and reloads the merged chat', async () => {
    importFromOtherApp.mockResolvedValue(SUMMARY);
    const onDone = vi.fn<(r: ImportResult) => void>();
    render(<OtherAppImportPanel preview={PREVIEW} onCancel={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 agent and merge' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.summary).toBe(SUMMARY);
    expect(result.agents.map((a) => a.name)).toEqual(['Chief of Staff', 'Finance']);
    expect(loadMessages).toHaveBeenCalledWith('chief');
  });

  it('words the done notes as information, with what was left behind', () => {
    const { container } = render(<DoneExtra summary={SUMMARY} />);
    expect(container.querySelector('.agents-import-behind')).not.toBeNull();
    expect(container.querySelector('.agents-import-problems')).toBeNull();
    expect(container).toHaveTextContent('rules stayed behind for Ada (npm test)');
    expect(container).toHaveTextContent('Already here from an earlier import');
  });
});

describe('import wording', () => {
  it('names sizes and what the button does', () => {
    expect(formatBytes(340 * 1024 * 1024)).toBe('340 MB');
    expect(formatBytes(500)).toBe('1 KB');
    const merge = agent({ plan: 'merge', isMain: true });
    const fresh = agent({ plan: 'new' });
    expect(importLabel([merge], 'Ada')).toBe('Merge into Ada');
    expect(importLabel([fresh, fresh], 'Ada')).toBe('Import 2 agents');
    expect(importLabel([], 'Ada')).toBe('Nothing to import');
  });
});
