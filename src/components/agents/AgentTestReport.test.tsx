/**
 * A card with a project in Agents mode: Preview and Test it open the pane
 * beside the chat (older cards too: only `project` is needed); outside Agents
 * mode Preview still opens the project. And what a test leaves on the card.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ResultCardView } from './AgentResult';
import { AgentPreviewProvider, useAgentPreviewRequest } from './AgentPreviewContext';
import { TestReportView } from './AgentTestReport';
import type { Agent, AgentMessage, ResultCard } from '../../lib/agents';
import type { TestReport } from '../../../packages/companion-protocol/src/results';

const agent = {
  id: 'site',
  name: 'Site Builder',
  home: '/h/site',
  status: { state: 'idle', activity: null, since: null },
} as Agent;

// A card from before Test it existed: a title, a summary and a project.
const OLD: ResultCard = {
  id: 'res-1',
  version: 1,
  title: 'Harbor Bakery site',
  summary: 'Home, menu and contact pages.',
  project: '/p/harbor-bakery',
};

const message: AgentMessage = {
  id: 'm1',
  agentId: 'site',
  ts: 1,
  kind: 'agent',
  text: OLD.summary,
  result: OLD,
};

function Showing() {
  const r = useAgentPreviewRequest();
  return (
    <output data-testid="pane">
      {r ? `${r.agentId}/${r.messageId}/${r.test ? 'test' : 'look'}` : 'closed'}
    </output>
  );
}

describe('Preview on a card, in Agents mode', () => {
  it('opens the pane beside the chat instead of the project', () => {
    const onPreview = vi.fn();
    render(
      <AgentPreviewProvider>
        <ResultCardView message={message} card={OLD} agent={agent} newest onPreview={onPreview} />
        <Showing />
      </AgentPreviewProvider>
    );
    expect(screen.getByTestId('pane').textContent).toBe('closed');
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    expect(screen.getByTestId('pane').textContent).toBe('site/m1/look');
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Test it' }));
    expect(screen.getByTestId('pane').textContent).toBe('site/m1/test');
  });

  it('outside Agents mode Preview still opens the project, and there is no Test it', () => {
    const onPreview = vi.fn();
    render(
      <ResultCardView message={message} card={OLD} agent={agent} newest onPreview={onPreview} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    expect(onPreview).toHaveBeenCalledWith('/p/harbor-bakery');
    expect(screen.queryByRole('button', { name: 'Test it' })).toBeNull();
  });

  it('a card without a project offers neither', () => {
    const card = { ...OLD, project: undefined };
    render(
      <AgentPreviewProvider>
        <ResultCardView message={{ ...message, result: card }} card={card} agent={agent} newest />
      </AgentPreviewProvider>
    );
    expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test it' })).toBeNull();
  });
});

const SHOT = {
  name: 'step-2.png',
  path: 'attachments/run-1/step-2.png',
  mime: 'image/png',
  size: 9,
};

const BROKEN: TestReport = {
  outcome: 'broken',
  summary: 'Menu and contact work; signing up for the newsletter fails.',
  broken: ['The newsletter form answers 404'],
  consoleErrors: ['POST /api/subscribe 404 (Not Found)'],
  steps: [
    { kind: 'open', label: 'Opened /', ok: true, ts: 1 },
    { kind: 'shot', label: 'Home page', ok: true, ts: 2, shot: SHOT },
    { kind: 'click', label: 'Clicked “Subscribe”', ok: true, ts: 3 },
    { kind: 'note', label: 'The form showed an error', ok: false, ts: 4 },
  ],
};

describe('what a test leaves on the card', () => {
  it("keeps the agent's words apart from what the page showed", () => {
    render(<TestReportView agent={agent} report={BROKEN} />);
    expect(screen.getByText('Tested in the preview: broken')).toBeTruthy();
    expect(screen.getByText(BROKEN.summary)).toBeTruthy();
    expect(screen.getByText('The newsletter form answers 404')).toBeTruthy();
    expect(screen.getByText('1 console error on the page')).toBeTruthy();
    expect(screen.getByText('POST /api/subscribe 404 (Not Found)')).toBeTruthy();
    const shot = screen.getByRole('button', { name: 'View screenshot: Home page' });
    expect(shot.querySelector('img')?.getAttribute('src')).toContain('step-2.png');
  });

  it('the steps fold under one line until asked for', () => {
    render(<TestReportView agent={agent} report={BROKEN} />);
    expect(screen.queryByText('Clicked “Subscribe”')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'What it did · 4 steps' }));
    expect(screen.getByText('Clicked “Subscribe”')).toBeTruthy();
  });

  it('a clean run says it works and shows no console section', () => {
    render(
      <TestReportView
        agent={agent}
        report={{ outcome: 'passed', summary: 'Every page and button worked.' }}
      />
    );
    expect(screen.getByText('Tested in the preview: it works')).toBeTruthy();
    expect(screen.queryByText(/console error/)).toBeNull();
  });
});
