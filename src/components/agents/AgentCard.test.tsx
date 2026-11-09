import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentCard, ConversationBars } from './AgentCard';

describe('AgentCard, answered', () => {
  it('becomes its outcome line, with the request one click away', () => {
    render(
      <AgentCard title="Let Claude Code work in demo-site?" source="Acme Site" outcome="Allowed">
        <p>Claude Code asks once per folder.</p>
      </AgentCard>
    );
    expect(screen.getByText('Let Claude Code work in demo-site?')).toBeInTheDocument();
    expect(screen.getByText('Allowed')).toBeInTheDocument();
    expect(screen.queryByText('Claude Code asks once per folder.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show request' }));
    expect(screen.getByText('Claude Code asks once per folder.')).toBeInTheDocument();
    expect(screen.getByText('Acme Site')).toBeInTheDocument();
  });

  it('stays whole when it was answered on screen, so the answer eases in where it was given', () => {
    render(
      <AgentCard title="Run a command" outcome="Allowed" resolved>
        <p>npm test</p>
      </AgentCard>
    );
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show request' })).toBeNull();
  });
});

describe('ConversationBars', () => {
  it('never folds a key in the draft into "N more"', () => {
    const { container } = render(
      <ConversationBars
        bars={[
          { id: 'takeover', node: <div>You’re driving</div> },
          { id: 'import', node: <div>Importing from Grok</div> },
          { id: 'secret', node: <div>A key in your draft</div> },
        ]}
      />
    );
    const slot = (id: string) =>
      container.querySelector<HTMLElement>(`.agent-bars__slot[data-bar="${id}"]`)!;
    expect(slot('secret').hidden).toBe(false);
    expect(slot('takeover').hidden).toBe(false);
    // Two at most: the import folds, not the warning.
    expect(slot('import').hidden).toBe(true);
    expect(screen.getByRole('button', { name: '1 more' })).toBeInTheDocument();
  });
});

describe('AgentCard, for assistive tech', () => {
  it('is a group named by its title, which is a heading', () => {
    render(
      <AgentCard title="Push to main?" actions={<button type="button">Allow</button>}>
        <p>3 commits</p>
      </AgentCard>
    );
    expect(screen.getByRole('group', { name: 'Push to main?' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Push to main?' })).toBeInTheDocument();
  });

  it('moves focus to the outcome when the answered button goes away', () => {
    const card = (answered: boolean) => (
      <AgentCard
        title="Push to main?"
        resolved={answered}
        outcome={answered ? 'Allowed' : undefined}
        actions={answered ? undefined : <button type="button">Allow</button>}
      />
    );
    const { rerender } = render(card(false));
    screen.getByRole('button', { name: 'Allow' }).focus();
    rerender(card(true));
    expect(document.activeElement).toHaveTextContent('Allowed');
  });

  it('leaves focus alone when it was elsewhere (answered from the phone)', () => {
    const card = (answered: boolean) => (
      <>
        <input aria-label="Composer" />
        <AgentCard
          title="Push to main?"
          resolved={answered}
          outcome={answered ? 'Allowed' : undefined}
          actions={answered ? undefined : <button type="button">Allow</button>}
        />
      </>
    );
    const { rerender } = render(card(false));
    const composer = screen.getByRole('textbox', { name: 'Composer' });
    composer.focus();
    rerender(card(true));
    expect(document.activeElement).toBe(composer);
  });
});
