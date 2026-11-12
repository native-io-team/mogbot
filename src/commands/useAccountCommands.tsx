import { LoginIcon } from '@/components/icons';
import { useOpenModal } from '../contexts/ModalContext';
import { requestAccountOnOpen } from '../lib/account';
import { relayOn } from '../lib/brand';
import { lastKnownRelay } from '../lib/companion';
import { requestSettingsTabOnOpen } from '../lib/settings';
import { useCommands } from './useCommands';

/**
 * Sign in / Sign out from ⌘K, only in a build with our hosted relay. Both
 * open Settings → Account, which starts the sign-in (and shows it waiting
 * for the browser) or asks before signing out (`takeAccountOnOpen`). Which
 * one is offered follows the last status read; before any, Sign in.
 */
export function useAccountCommands() {
  const openModal = useOpenModal();
  useCommands(() => {
    const open = (what: 'signIn' | 'signOut') => {
      requestAccountOnOpen(what);
      requestSettingsTabOnOpen('account');
      openModal('settings');
    };
    const signedIn = () => !!lastKnownRelay()?.account;
    return [
      {
        id: 'account.signIn',
        title: 'Sign in',
        subtitle: 'Your phone reaches this Mac from anywhere',
        icon: <LoginIcon size={14} />,
        category: 'settings' as const,
        keywords: ['account', 'log in', 'google', 'email', 'relay'],
        when: () => relayOn() && !signedIn(),
        run: () => open('signIn'),
      },
      {
        id: 'account.signOut',
        title: 'Sign out…',
        icon: <LoginIcon size={14} />,
        category: 'settings' as const,
        keywords: ['account', 'log out'],
        when: () => relayOn() && signedIn(),
        run: () => open('signOut'),
      },
    ];
  }, [openModal]);
}
