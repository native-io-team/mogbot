import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectListStatus } from './ProjectListStatus';

/**
 * These pin the two decisions this component makes that a reader would
 * otherwise have to infer from the ternary it was extracted from.
 */
describe('ProjectListStatus', () => {
  it('renders nothing once the scan has succeeded', () => {
    const { container } = render(
      <ProjectListStatus loading={false} loadError={null} onRetry={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the spinner, and the cleanup message under it, while scanning', () => {
    render(
      <ProjectListStatus
        loading
        loadError={null}
        cleanupStatus="Tidying up 3 removed projects"
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('Loading projects…')).toBeInTheDocument();
    expect(screen.getByText('Tidying up 3 removed projects')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces a failed scan and offers a retry', async () => {
    const onRetry = vi.fn();
    render(
      <ProjectListStatus
        loading={false}
        loadError="projects folder is on a disconnected volume"
        onRetry={onRetry}
      />
    );

    // role="alert" is what makes this reach a screen reader rather than
    // silently replacing the grid.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('projects folder is on a disconnected volume');

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the spinner rather than the stale error while a retry is in flight', () => {
    // Precedence carried over from the ternary this was extracted from:
    // pressing "Try again" sets loading without clearing loadError, and the
    // user must see the retry happening, not the failure they just dismissed.
    render(
      <ProjectListStatus
        loading
        loadError="projects folder is on a disconnected volume"
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('Loading projects…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByText('projects folder is on a disconnected volume')
    ).not.toBeInTheDocument();
  });
});
