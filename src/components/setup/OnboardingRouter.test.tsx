/**
 * The onboarding window shows the agent-led flow, and nothing else: the
 * classic wizard and its corner toggle are gone.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OnboardingRouter } from './OnboardingRouter';

vi.mock('./agent-led/AgentOnboardingScreen', () => ({
  AgentOnboardingScreen: () => <div data-testid="agent-screen" />,
}));

describe('OnboardingRouter', () => {
  it('shows the agent-led flow', () => {
    render(<OnboardingRouter onComplete={vi.fn()} />);
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
  });

  it('offers no classic wizard', () => {
    localStorage.setItem('shipstudio.onboardingMode', 'classic');
    render(<OnboardingRouter onComplete={vi.fn()} />);
    expect(screen.getByTestId('agent-screen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /classic/i })).not.toBeInTheDocument();
  });
});
