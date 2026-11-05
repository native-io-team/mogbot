/**
 * Carries an agent's accent scope across React portals.
 *
 * `data-accent-scope` works by DOM inheritance, and a modal, dropdown or
 * context menu is portalled to `document.body` — outside the agent chat whose
 * colour it should take. So the scope travels in context as well: the portal
 * primitives read it and put the same attributes on their own root.
 *
 * @module contexts/AccentScopeContext
 */

import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { useAccentScope, type accentScopeProps } from '../lib/accent';

type AccentScopeAttrs = ReturnType<typeof accentScopeProps>;

const AccentScopeContext = createContext<AccentScopeAttrs | null>(null);

/** Provides an already-built scope (from `useAccentScope`) to portalled descendants. */
export function AccentScopeProvider({
  scope,
  children,
}: {
  scope: AccentScopeAttrs;
  children: ReactNode;
}) {
  return <AccentScopeContext.Provider value={scope}>{children}</AccentScopeContext.Provider>;
}

/**
 * Scopes everything inside to `color` — portals included. Renders no element,
 * so whatever it wraps must sit inside an element that already carries the
 * scope, or be portalled (a modal).
 */
export function AccentScope({ color, children }: { color: string; children: ReactNode }) {
  const scope = useAccentScope(color);
  return <AccentScopeProvider scope={scope}>{children}</AccentScopeProvider>;
}

/**
 * Attributes for a portal's root element: the surrounding scope, if any, with
 * the element's own style merged over it. Outside any scope this is just the
 * element's own style, so the app accent applies as before.
 */
export function usePortalAccentScope(style?: CSSProperties): {
  'data-accent-scope'?: string;
  style?: CSSProperties;
} {
  const scope = useContext(AccentScopeContext);
  if (!scope) return { style };
  return {
    'data-accent-scope': scope['data-accent-scope'],
    style: { ...scope.style, ...style },
  };
}
