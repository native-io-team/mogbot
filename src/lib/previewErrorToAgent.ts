/**
 * "Send this error to the agent" from the preview's error page.
 *
 * The request arrives as a postMessage from the preview iframe — a page that
 * runs the user's project and every one of its dependencies. Anything there can
 * post the same message, so the message is never acted on directly: it only
 * raises a chip in the app (outside the iframe) showing the exact text, and the
 * text goes to an agent tab only when the user clicks it. It is pasted as one
 * bracketed prompt with every control byte stripped and no Return, and never
 * into a plain shell tab.
 */
import type { CommentAgent } from './canvasComments';
import { stripTerminalControls } from './terminalPrompt';

/** Long enough for a stack trace; short enough that the chip can show it all. */
export const PREVIEW_ERROR_MAX_CHARS = 4000;

/** The error text a chip may show, or null when there is nothing to show. */
export function cleanPreviewError(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const clean = stripTerminalControls(message).trim();
  if (!clean) return null;
  return clean.length > PREVIEW_ERROR_MAX_CHARS
    ? `${clean.slice(0, PREVIEW_ERROR_MAX_CHARS)}…`
    : clean;
}

export function previewErrorPrompt(error: string): string {
  return `My dev server is returning an error:\n\n${error}\n\nPlease help me fix this.`;
}

/** The agent tab to send to: the active one if it is an agent, else the first
 *  agent tab. Shell tabs are never a target. */
export function pickErrorAgent(agents: CommentAgent[]): CommentAgent | null {
  const candidates = agents.filter((agent) => agent.isAgent === true);
  return candidates.find((agent) => agent.isActive) ?? candidates[0] ?? null;
}
