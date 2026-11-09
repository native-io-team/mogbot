/**
 * The chat header's role gives way to the account; cut to "Desig…" or "D…"
 * it is dropped instead, so the account reads whole (ChatView `Header`).
 */
import { headerSubtitle, roleCutPastReading } from '../src/lib/accountsView';

describe('roleCutPastReading', () => {
  it('drops a role cut to a stub', () => {
    // "Design system" at 12pt, squeezed to "Desig…" and to "D…".
    expect(roleCutPastReading(40, 'Design system', 12)).toBe(true);
    expect(roleCutPastReading(14, 'Design system', 13)).toBe(true);
  });

  it('keeps a role laid out whole, or near enough to read', () => {
    expect(roleCutPastReading(80, 'Design system', 12)).toBe(false);
    expect(roleCutPastReading(76, 'Runs the team', 12)).toBe(false);
    expect(roleCutPastReading(60, 'Marketing site', 12)).toBe(false);
  });

  it('never drops a short role, or one not laid out yet', () => {
    expect(roleCutPastReading(14, 'QA', 12)).toBe(false);
    expect(roleCutPastReading(0, 'Design system', 12)).toBe(false);
  });

  it('leaves the account reading as its own line', () => {
    expect(headerSubtitle({ role: '', ranOn: { name: 'sam@example.com' } as never })).toBe(
      'On sam@example.com'
    );
  });
});
