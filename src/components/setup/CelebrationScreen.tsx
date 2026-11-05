/**
 * The end of onboarding: the hand-off to the Chief of Staff.
 *
 * Says only what the app verified (the engine is installed and signed in)
 * and where the user is going next. It waits for the click rather than
 * timing out: this is the one moment that says what comes next, and a screen
 * that vanishes in two seconds says nothing. A ref guard makes sure
 * `onContinue` fires exactly once, however often the button is pressed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { AgentAvatar } from '../agents/AgentAvatar';

/** The Chief's name and colour as `agents::ensure_main` creates it. */
const CHIEF_NAME = 'Chief of Staff';
const CHIEF_COLOR = 'white';

interface CelebrationScreenProps {
  /** Called when user clicks to continue */
  onContinue: () => void;
  /**
   * The engine onboarding verified ("Claude Code"), or null when it can't
   * be named.
   */
  engineName: string | null;
}

export function CelebrationScreen({ onContinue, engineName }: CelebrationScreenProps) {
  const [showContent, setShowContent] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const firedRef = useRef(false);

  const fireContinue = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    // Completion can take a few seconds (persisting setup state, opening
    // Agents) — a click with zero feedback reads as a broken button.
    setIsContinuing(true);
    onContinue();
  }, [onContinue]);

  // Animate in the content
  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={`celebration-screen ${showContent ? 'visible' : ''}`}>
      <div className="celebration-content">
        <div className="celebration-icon">
          <AgentAvatar name={CHIEF_NAME} color={CHIEF_COLOR} size="hero" selected />
        </div>
        <h1 className="celebration-title">You're all set</h1>
        <p className="celebration-subtitle">
          {engineName
            ? `${engineName} is connected. Your Chief of Staff is waiting for you.`
            : 'Your Chief of Staff is waiting for you.'}
        </p>
        <Button
          variant="primary"
          size="large"
          className="celebration-btn"
          onClick={fireContinue}
          disabled={isContinuing}
          autoFocus
        >
          {isContinuing ? <Spinner size="sm" /> : 'Meet your Chief of Staff'}
        </Button>
      </div>
    </div>
  );
}
