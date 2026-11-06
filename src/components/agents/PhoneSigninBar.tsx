/**
 * The bar on every conversation while the phone signs in to a site in this
 * Mac's Chrome (`lib/phoneSignin.ts`): what's happening, and Stop. Stopping
 * loses nothing, so it's a secondary button. Gone when nothing is.
 *
 * @module components/agents/PhoneSigninBar
 */

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../primitives/Button';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  getPhoneSignin,
  PHONE_SIGNIN_EVENT,
  phoneSigninDetail,
  phoneSigninTitle,
  stopPhoneSignin,
  type PhoneSignin,
} from '../../lib/phoneSignin';
import { ConversationBar } from './AgentCard';

export function PhoneSigninBar() {
  const [live, setLive] = useState<PhoneSignin | null>(null);
  const [stopping, setStopping] = useState(false);
  const { showToast } = useOptionalToast();

  useEffect(() => {
    let gone = false;
    getPhoneSignin()
      .then((s) => !gone && setLive(s))
      .catch(() => {});
    const off = listen<PhoneSignin | null>(PHONE_SIGNIN_EVENT, (e) => setLive(e.payload));
    return () => {
      gone = true;
      void off.then((f) => f());
    };
  }, []);

  if (!live) return null;
  return (
    <ConversationBar
      state="active"
      role="alert"
      data-testid="phone-signin-bar"
      title={phoneSigninTitle(live)}
      detail={phoneSigninDetail(live)}
      actions={
        <Button
          size="compact"
          variant="secondary"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            stopPhoneSignin()
              .then(() => setLive(null))
              .catch((e) => showToast(formatCommandError(asCommandError(e)), 'error'))
              .finally(() => setStopping(false));
          }}
        >
          Stop
        </Button>
      }
    />
  );
}
