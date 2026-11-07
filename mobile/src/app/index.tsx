import { Redirect } from 'expo-router';
import { useApp } from '../lib/store';

export default function Index() {
  const paired = useApp((s) => Boolean(s.credentials));
  return <Redirect href={paired ? '/agents' : '/pair'} />;
}

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
