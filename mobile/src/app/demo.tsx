/**
 * "Try the demo" (the welcome screen's button, or `<scheme>://demo`): sample
 * agents with no Mac and no network (lib/demo.ts). Never over a real
 * pairing: paired, it only opens your agents.
 */

import { Redirect } from 'expo-router';
import { useEffect } from 'react';
import { startDemo } from '../lib/session';
import { useApp } from '../lib/store';

export default function Demo() {
  // Something to show once the demo (or a real pairing) is in place.
  const ready = useApp((s) => !!s.credentials);
  useEffect(() => {
    startDemo();
  }, []);
  return ready ? <Redirect href="/agents" /> : null;
}

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
