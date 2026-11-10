/**
 * Share an agent as a recipe on the desk: the sheet shows exactly what the
 * Mac says is in it, counts what was removed, says what is never in one,
 * copies the text the Chief's chat reads back, and saves only the JSON it
 * showed. Fictional agents throughout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CLEAN_PREVIEW, FINANCE_PREVIEW } from '../../harness/fixtures/recipe';
import { isRecipeFile, looksLikeRecipe, removedLine } from '../../lib/agentRecipe';

const api = vi.hoisted(() => ({
  previewRecipe: vi.fn(),
  saveRecipe: vi.fn(),
}));
vi.mock('../../lib/agentRecipe', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentRecipe')>()),
  ...api,
}));
const dialog = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => dialog);
const STATE = { agents: [{ id: 'finance', name: 'Finance', isMain: false }] };
vi.mock('../../lib/agentsStore', () => ({
  useAgentsSelector: <T,>(sel: (s: typeof STATE) => T) => sel(STATE),
}));
vi.mock('./AgentKey', () => ({ AgentKey: () => <span data-testid="key" /> }));
const copied = vi.hoisted(() => ({ text: '' }));
vi.mock('../../hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({
    copy: (t: string) => {
      copied.text = t;
    },
    isCopied: false,
  }),
}));

import { AgentRecipeModal } from './AgentRecipeModal';

beforeEach(() => {
  api.previewRecipe.mockReset().mockResolvedValue(FINANCE_PREVIEW);
  api.saveRecipe.mockReset().mockResolvedValue(undefined);
  dialog.save.mockReset();
  copied.text = '';
});

describe('removedLine', () => {
  it('counts personal details and secrets apart, and says nothing when nothing went', () => {
    expect(removedLine({ emails: 1, phones: 1, paths: 2, secrets: 1 })).toBe(
      '4 personal details removed (1 email address, 1 phone number, 2 file paths). 1 password or key removed'
    );
    expect(removedLine({ emails: 2, phones: 0, paths: 0, secrets: 0 })).toBe(
      '2 personal details removed (2 email addresses)'
    );
    expect(removedLine({ emails: 0, phones: 0, paths: 0, secrets: 0 })).toBeNull();
  });
});

describe('recognising a recipe', () => {
  it('knows its text and its files, and nothing else', () => {
    expect(looksLikeRecipe(FINANCE_PREVIEW.text)).toBe(true);
    expect(looksLikeRecipe(FINANCE_PREVIEW.json)).toBe(true);
    expect(looksLikeRecipe('Can you make a recipe agent for my "format"?')).toBe(false);
    expect(looksLikeRecipe('{"format": "agent-recipe"}')).toBe(false);
    expect(isRecipeFile('/Users/me/Downloads/Finance.mogbot-recipe.json')).toBe(true);
    expect(isRecipeFile('/Users/me/Downloads/report.json')).toBe(false);
  });
});

describe('AgentRecipeModal', () => {
  it('shows what is in it, what was removed and what never is', async () => {
    render(<AgentRecipeModal agentId="finance" onClose={vi.fn()} />);
    expect(await screen.findByTestId('agent-recipe')).toBeTruthy();
    expect(api.previewRecipe).toHaveBeenCalledWith('finance');
    expect(screen.getByRole('status').textContent).toContain('4 personal details removed');
    expect(screen.getByText(/Check for new invoices/)).toBeTruthy();
    expect(screen.getByText('Gmail, Google Sheets, Linear')).toBeTruthy();
    expect(screen.getByText(/Suggests Careful/)).toBeTruthy();
    expect(screen.getByText('Its memory and everything it knows about you')).toBeTruthy();
    // Removed text shows where it was, never the text itself.
    expect(document.body.textContent).toContain('[removed: an email address]');
  });

  it('has no removed line when nothing was', async () => {
    api.previewRecipe.mockResolvedValue(CLEAN_PREVIEW);
    render(<AgentRecipeModal agentId="leadgen" onClose={vi.fn()} />);
    await screen.findByTestId('agent-recipe');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('copies the text the Chief reads back', async () => {
    render(<AgentRecipeModal agentId="finance" onClose={vi.fn()} />);
    await screen.findByTestId('agent-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Copy as text' }));
    expect(copied.text).toBe(FINANCE_PREVIEW.text);
    expect(looksLikeRecipe(copied.text)).toBe(true);
  });

  it('saves exactly the JSON it showed, where the user picked', async () => {
    dialog.save.mockResolvedValue('/Users/me/Desktop/Finance.mogbot-recipe.json');
    const onClose = vi.fn();
    render(<AgentRecipeModal agentId="finance" onClose={onClose} />);
    await screen.findByTestId('agent-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Save file…' }));
    await waitFor(() => expect(api.saveRecipe).toHaveBeenCalled());
    expect((dialog.save.mock.calls[0][0] as { defaultPath?: string }).defaultPath).toBe(
      FINANCE_PREVIEW.fileName
    );
    expect(api.saveRecipe).toHaveBeenCalledWith(
      'finance',
      '/Users/me/Desktop/Finance.mogbot-recipe.json',
      FINANCE_PREVIEW.json
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('saves nothing when the user cancels the save sheet', async () => {
    dialog.save.mockResolvedValue(null);
    render(<AgentRecipeModal agentId="finance" onClose={vi.fn()} />);
    await screen.findByTestId('agent-recipe');
    fireEvent.click(screen.getByRole('button', { name: 'Save file…' }));
    await waitFor(() => expect(dialog.save).toHaveBeenCalled());
    expect(api.saveRecipe).not.toHaveBeenCalled();
  });
});
