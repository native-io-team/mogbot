/**
 * "Apps your agents can use": the words the desk's dialog
 * (`src/components/agents/AgentAppsModal.tsx`) and the phone's screen
 * (`mobile/src/app/apps.tsx`) share, so the two say the same thing.
 */

/** The two ways an agent can use an app, as both pickers label them. */
export const ACCESS_CHOICES = [
  { value: 'read', label: 'Read only' },
  { value: 'full', label: 'Read and change' },
] as const;

/** What the picked access means, under the picker. `nobody`: no agent ticked. */
export function grantNote(access: 'read' | 'full', nobody: boolean): string {
  const base =
    access === 'full'
      ? 'Every change asks you on a card first.'
      : 'Anything that changes something is refused; they can ask you for more.';
  return nobody ? `${base} No agent ticked: it’s kept for later, and nobody uses it yet.` : base;
}

/** Where a connection's sign-in is kept, by its kind (`oauth`, `gh`, `claude_ai`). */
export function keptWhere(kind: string): string {
  if (kind === 'oauth') return 'Signed in on this Mac';
  if (kind === 'gh') return 'GitHub CLI on this Mac';
  if (kind === 'mac_app') return 'This Mac’s own app';
  return 'Connected on claude.ai';
}

/** Who's ticked when a connect opens: the agent it was opened for, else the Chief; never the whole team. */
export function defaultGrantees(
  agents: readonly { id: string; isMain: boolean }[],
  forAgentId?: string | null
): string[] {
  if (forAgentId && agents.some((a) => a.id === forAgentId)) return [forAgentId];
  const chief = agents.find((a) => a.isMain);
  return chief ? [chief.id] : [];
}

/** "Chief and Recruiter can read" / "No agent can use it yet": who a connection reaches, and how. */
export function grantsLine<G extends { agentId: string; access: 'read' | 'full' }>(
  connection: { grants: readonly G[] },
  names: ReadonlyMap<string, string>
): string {
  const named = connection.grants.filter((g) => names.has(g.agentId));
  if (named.length === 0) return 'No agent can use it yet';
  const list = (ids: string[]) => {
    const n = ids.map((id) => names.get(id) ?? id);
    if (n.length <= 1) return n[0] ?? '';
    return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  };
  const read = named.filter((g) => g.access === 'read').map((g) => g.agentId);
  const full = named.filter((g) => g.access === 'full').map((g) => g.agentId);
  const parts: string[] = [];
  if (full.length) parts.push(`${list(full)} can read and change (asks first)`);
  if (read.length) parts.push(`${list(read)} can read`);
  return parts.join('; ');
}

/** The account a connection signed in as, when it said; else nothing. */
export function connectionAccount(c: { account: string; title: string }): string | null {
  return c.account && c.account !== c.title ? c.account : null;
}

/** The access a "Who can use it" picker opens on: full if anyone has it, else read. */
export function pickerAccess(grants: readonly { access: 'read' | 'full' }[]): 'read' | 'full' {
  return grants.some((g) => g.access === 'full') ? 'full' : 'read';
}
