/** Guard batch pastes against setup/permission menus and busy agent sessions. */
export function assertPromptReady(screen: string, thinking: boolean): void {
  if (thinking) throw new Error('This agent is busy. Wait for its prompt before sending comments.');
  const visible = screen.replace(/\s+/g, ' ');
  if (
    /trust (?:this |the )?(?:folder|directory|workspace)|accessing workspace|enter to confirm|select (?:a )?login|sign in to continue|log in to continue|allow once|allow always|do you want to proceed/i.test(
      visible
    )
  ) {
    throw new Error(
      'Finish the setup or permission prompt in the terminal, then send your comments. They are still pending.'
    );
  }
}

/** Strip terminal control bytes; keep newlines inside the bracketed paste. */
export function bracketedPrompt(text: string): string {
  const clean = Array.from(text)
    .filter((char) => !isControl(char))
    .join('');
  return `\x1b[200~${clean}\x1b[201~`;
}

/** A character a terminal treats as a control: C0 (bar tab/newline), DEL, or C1.
 *  ESC (0x1b) is the dangerous one — `\x1b[201~` ends a bracketed paste early so
 *  the rest of the text runs as typed input — but 8-bit C1 (0x9b is CSI on its
 *  own) can do the same, so both ranges go. */
function isControl(char: string): boolean {
  if (char === '\n' || char === '\t') return false;
  const code = char.charCodeAt(0);
  return code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f);
}

/** Text that is safe to hand to xterm's `paste`: line endings normalised to `\n`
 *  and every other control byte dropped. Every paste path into a terminal goes
 *  through this — clipboard text, a file path, an iframe's or an agent's words
 *  are never trusted with ESC. */
export function stripTerminalControls(text: string): string {
  return Array.from(text.replace(/\r\n?/g, '\n'))
    .filter((char) => !isControl(char))
    .join('');
}
