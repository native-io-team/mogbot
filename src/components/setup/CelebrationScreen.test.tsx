/**
 * Tests for CelebrationScreen: the hand-off from onboarding to Agents.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CelebrationScreen } from './CelebrationScreen';

describe('CelebrationScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the verified engine and hands off to the Chief of Staff', () => {
    render(<CelebrationScreen onContinue={vi.fn()} engineName="Claude Code" />);

    expect(screen.getByText("You're all set")).toBeInTheDocument();
    expect(
      screen.getByText('Claude Code is connected. Your Chief of Staff is waiting for you.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Meet your Chief of Staff' })).toBeInTheDocument();
  });

  it('names no engine it did not verify', () => {
    render(<CelebrationScreen onContinue={vi.fn()} engineName={null} />);

    expect(screen.getByText('Your Chief of Staff is waiting for you.')).toBeInTheDocument();
    expect(screen.queryByText(/is connected/)).not.toBeInTheDocument();
  });

  it('waits for the click rather than moving on by itself', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} engineName="Claude Code" />);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onContinue).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Meet your Chief of Staff' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('fires onContinue exactly once on rapid double-click', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} engineName="Claude Code" />);

    const button = screen.getByRole('button');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('shows a pending spinner on the button after clicking (completion can take seconds)', () => {
    render(<CelebrationScreen onContinue={vi.fn()} engineName="Claude Code" />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(screen.queryByText('Meet your Chief of Staff')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('animates in (visible class applied after 100ms)', () => {
    const { container } = render(
      <CelebrationScreen onContinue={vi.fn()} engineName="Claude Code" />
    );

    const screenEl = container.querySelector('.celebration-screen');
    expect(screenEl).not.toHaveClass('visible');

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(screenEl).toHaveClass('visible');
  });
});
