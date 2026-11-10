/**
 * Import from the phone, as plain decisions: whether the home asks "bring
 * your agents, or start fresh?" (once, while the Mac says it's undecided),
 * and which one of the import screen's three steps shows.
 */

import type { AgentsOverview, ImportTalk, PhoneImportStatus } from '@shipstudio/companion-protocol';

/** Whether the home asks: undecided, and this Mac can both import and take the answer. */
export function asksImportChoice(
  overview: Pick<AgentsOverview, 'importChoice'> | null | undefined,
  welcome: { methods: readonly string[] } | null | undefined
): boolean {
  const methods = welcome?.methods ?? [];
  return (
    overview?.importChoice === 'undecided' &&
    methods.includes('agents.setImportChoice') &&
    methods.includes('agents.import.status')
  );
}

/**
 * Which one of the three screens shows, from what the Mac says: connect
 * (Remote access on and the assistant connected, done once at the Mac),
 * start (Start, then the message), or follow (the import, in the Chief's
 * chat). One at a time, never all three.
 */
export function phoneImportStep(status: PhoneImportStatus | null): {
  id: 'connect' | 'start' | 'follow';
  index: 1 | 2 | 3;
  reachable: boolean;
} {
  const remote = status?.remoteAccess;
  const reachable = !!remote?.enabled && !!remote.funnelOn;
  if (status?.talk) return { id: 'follow', index: 3, reachable };
  if (!status || !reachable || !remote?.everConnected) {
    return { id: 'connect', index: 1, reachable };
  }
  return { id: 'start', index: 2, reachable };
}

/**
 * The follow step's heading: what the user does now, if anything. While the
 * other assistant is sending, there is nothing to answer, so it never says so.
 */
export function phoneTalkHeading(talk: ImportTalk, chief: string): string {
  switch (talk.state) {
    case 'awaiting_consent':
      return `Allow ${talk.source} in ${chief}’s chat`;
    case 'interviewing':
      return `${talk.source} is sending everything`;
    case 'playback':
      return `Check the plan in ${chief}’s chat`;
    case 'review':
      return `Review them in ${chief}’s chat`;
    case 'imported':
      return talk.imported.length ? 'Your team is here' : 'Done';
    default:
      return 'Nothing was imported';
  }
}

/**
 * The imported agents that are on the Mac now, to open their chats: an
 * import ends with the user talking to them. A name not found is left out.
 */
export function importedHere(
  talk: ImportTalk,
  agents: { id: string; name: string }[]
): { id: string; name: string }[] {
  if (talk.state !== 'imported') return [];
  return talk.imported.flatMap((name) => {
    const found = agents.find((a) => a.name === name);
    return found ? [{ id: found.id, name: found.name }] : [];
  });
}

/**
 * A pasted reply's problem, as the desk says it (`pasteProblemInWords` in
 * ImportParts): one already in plain words with its own fix (cut off: send
 * that part again) is said as it is; anything else is the plain sentence,
 * with the parser's own line after it.
 */
export function pasteProblemLine(problems: string[]): string {
  const generic =
    'That reply isn’t in the format we asked for. Copy the message again and ask for just the code block.';
  if (!problems.length) return generic;
  const [p] = problems;
  const parserLine = /\bline \d|valid JSON|should be|"[a-z_]+"/.test(p);
  const saysTheFix = /\b(Ask|Paste|Send)\b/.test(p);
  return problems.length === 1 && !parserLine && saysTheFix ? p : `${generic} ${p}`;
}
