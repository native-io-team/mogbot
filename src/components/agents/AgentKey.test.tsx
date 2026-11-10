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

  it('keeps a paused key drained but whole, and a new one an empty socket', () => {
    const { container, rerender } = render(
      <AgentKey name="Inbox" colorway="teal" state="paused" size="xl" />
    );
    // Paused: you can still see whose key it is (the site's board).
    expect(container.querySelector('.agent-key__cap .agent-key__face svg')).not.toBeNull();
    expect(container.querySelector('.agent-key__socket')).toBeNull();
    rerender(<AgentKey name="New" state="new" size="xl" />);
    expect(container.querySelector('.agent-key__cap')).toBeNull();
    expect(container.querySelector('.agent-key[data-state="new"] .agent-key__stem')).not.toBeNull();
  });

  it('carries its agent id (for the bound-key press) and a seat flag', () => {
    const { container } = render(<AgentKey id="a1" name="Inbox" seat size="xl" />);
    const key = container.querySelector('.agent-key')!;
    expect(key.getAttribute('data-agent-id')).toBe('a1');
    expect(key.hasAttribute('data-seat')).toBe(true);
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

  it('animates only what needs it, with the site’s timings, and nothing with Reduce Motion', () => {
    const animations = [...css.matchAll(/animation:\s*([^;]+);/g)].map((m) => m[1]);
    expect(animations.filter((a) => a !== 'none').sort()).toEqual(
      [
        'agent-key-breathe var(--agent-key-breathe) ease-in-out infinite',
        'agent-key-breathe var(--agent-key-breathe) ease-in-out infinite',
        'agent-key-glow var(--agent-key-breathe) ease-in-out infinite',
        'agent-key-pulse var(--agent-key-pulse) ease-in-out infinite',
        'agent-key-pulse var(--agent-key-pulse) ease-in-out infinite',
        'agent-key-seat var(--agent-key-seat) var(--agent-key-ease-arrive) both',
        'agent-key-socket-in var(--agent-key-socket-in) var(--agent-key-ease-arrive) both',
      ].sort()
    );
    expect(css).toMatch(/--agent-key-pulse: 1\.6s;/);
    expect(css).toMatch(/--agent-key-breathe: 2\.4s;/);
    // Keyframes move only opacity, translate and (on the legend) filter.
    const frames = [...css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    for (const f of frames) {
      const props = [...f.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]);
      for (const p of props) expect(['opacity', 'translate', 'filter']).toContain(p);
    }
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(
      /\[data-state='needsOk'\] \.agent-key__legend,[\s\S]*?animation: none;/
    );
    expect(reduced).toContain(".agent-key[data-state='working']::before");
  });

  it('tells working, free and needs-you apart without motion', () => {
    // Needs you: its own amber legend and spill, raised; working: pressed and warm-lit.
    expect(css).toMatch(
      /\[data-state='needsOk'\] \.agent-key__legend \{\s*stroke: var\(--agent-key-ask\)/
    );
    expect(css).toMatch(/\[data-state='needsOk'\]::before \{[^}]*--agent-key-ask-spill/);
    expect(css).toMatch(
      /\[data-state='working'\] \{\s*--agent-key-ty: calc\(var\(--agent-key-rest-depth\)/
    );
    expect(css).toMatch(/\[data-state='needsOk'\] \{\s*--agent-key-ty: calc\(-5/);
  });

  it('holds every looping animation still in a hidden window', () => {
    const hidden = css.slice(css.indexOf(':root:is([data-app-hidden], [data-app-background])'));
    expect(hidden).toContain("[data-state='working'], [data-state='needsOk'])::before");
    expect(hidden).toContain('.agent-key__face::after');
    expect(hidden).toContain("[data-state='needsOk']");
    expect(hidden).toContain('animation-play-state: paused');
  });
});
