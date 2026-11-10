import { Redirect } from 'expo-router';
import { launchLanding } from '../lib/landing';
import { useApp } from '../lib/store';

/** Catch up when something waits on you, else Agents (lib/landing.ts). */
export default function Index() {
  const paired = useApp((s) => Boolean(s.credentials));
  return <Redirect href={paired ? launchLanding() : '/pair'} />;
}

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
