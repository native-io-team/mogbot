import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AgentKey } from './AgentKey';
import { COLORWAYS } from '../../../packages/companion-protocol/src/agentKeys';

// Paths from the repo root, where Vitest runs.
const css = readFileSync('src/styles/features/agent-key.css', 'utf8');

describe('AgentKey', () => {
  it('draws one legend from the registry on its colourway, with its key and pips at full size', () => {
    const { container } = render(
      <AgentKey
        name="Inbox"
        colorway="blue"
        icon="inbox"
        boundKey="I"
        level="judgement"
        size="xl"
      />
    );
    const key = container.querySelector('.agent-key')!;
    expect(key.getAttribute('data-colorway')).toBe('blue');
    expect(key.getAttribute('data-state')).toBe('idle');
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(container.querySelector('svg')!.getAttribute('data-dynamic-svg')).toBe('agent-key');
    expect(container.querySelector('.agent-key__sub')!.textContent).toBe('I');
    const pips = container.querySelectorAll('.agent-key__pip');
    expect(pips).toHaveLength(4);
    expect(container.querySelectorAll('.agent-key__pip[data-on]')).toHaveLength(2);
  });

  it('leaves the sublegend and pips off a small key', () => {
    const { container } = render(
      <AgentKey
        name="Inbox"
        colorway="blue"
        icon="inbox"
        boundKey="I"
        level="full_send"
        size="md"
      />
    );
    expect(container.querySelector('.agent-key__sub')).toBeNull();
    expect(container.querySelector('.agent-key__pips')).toBeNull();
  });

  it('is a socket with no cap when paused or new, its stem in its colour', () => {
    const { container, rerender } = render(
      <AgentKey name="Inbox" colorway="teal" state="paused" size="xl" />
    );
    expect(container.querySelector('.agent-key__face')).toBeNull();
    expect(container.querySelector('.agent-key__stem')).not.toBeNull();
    rerender(<AgentKey name="New" state="new" size="xl" />);
    expect(container.querySelector('.agent-key[data-state="new"] .agent-key__stem')).not.toBeNull();
  });

  it('draws an agent from an older Mac from its colour, name and role', () => {
    const { container } = render(<AgentKey name="Finance" color="amber" />);
    const key = container.querySelector('.agent-key')!;
    expect(key.getAttribute('data-colorway')).toBe('mustard');
    expect(key.getAttribute('data-icon')).toBe('money');
    expect(key.hasAttribute('data-light')).toBe(true);
  });

  it('has every colourway in the stylesheet, value for value', () => {
    for (const c of COLORWAYS) {
      for (const part of ['face', 'skirt', 'depth', 'legend'] as const) {
        const m = css.match(new RegExp(`--agent-key-${c.id}-${part}: (#[0-9a-f]{6});`));
        expect(m?.[1], `${c.id} ${part}`).toBe(c[part].toLowerCase());
      }
      expect(css).toContain(`.agent-key[data-colorway='${c.id}']`);
    }
  });

  it('animates only Needs your OK, and not with Reduce Motion', () => {
    const animations = [...css.matchAll(/animation:\s*([^;]+);/g)].map((m) => m[1]);
    expect(animations.filter((a) => a !== 'none')).toEqual([
      'agent-key-lit var(--agent-key-pulse) ease-in-out infinite',
    ]);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\[data-state='needsOk'\] \.agent-key__legend \{\s*animation: none;/);
  });
});
