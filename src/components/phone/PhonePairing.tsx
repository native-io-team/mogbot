/**
 * The three moments of pairing: offer to pair, show the code, and ask
 * whether to allow the phone that used it.
 *
 * The confirmation is the point. A QR code photographed over a shoulder
 * gets a stranger as far as this prompt, with their phone's name on it.
 *
 * @module components/phone/PhonePairing
 */

import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { TextButton } from '../primitives/TextButton';
import { CopyIcon, MobileIcon, WarningIcon } from '@/components/icons';
import {
  deviceLine,
  expiresIn,
  phoneTailscaleText,
  type PairRequestView,
  type PairingCode,
  type TailscaleState,
} from '../../lib/companion';
import { PhoneQr } from './PhoneQr';
import { TailscaleStoreLinks } from './PhoneTailscale';
import { BRAND } from '../../lib/brand';
import { formatClock } from '../../../packages/companion-protocol/src/clock';
import {
  PAIR_BUTTON,
  PAIR_YOUR_PHONE,
  SCAN_THE_CODE,
} from '../../../packages/companion-protocol/src/pairWords';
import { THIS_COMPUTER } from '../../lib/computer';

interface OfferProps {
  busy: boolean;
  /** No phone paired yet (the code was cancelled or ran out). */
  first?: boolean;
  onPair: () => void;
}

/**
 * The way to a code once setup is done. Its button is the phone app's own
 * instruction, "Pair your phone", so whichever way the panel was opened the
 * words on the phone match a button here.
 */
export function PairOffer({ busy, first = false, onPair }: OfferProps) {
  return (
    <div className="phone-offer">
      <span className="phone-offer__icon" aria-hidden>
        <MobileIcon size={18} />
      </span>
      <div className="phone-offer__body">
        <span className="phone-offer__title">
          {first ? 'Ready to pair' : 'Another phone, or this one again'}
        </span>
        <span className="phone-offer__detail">
          Shows a one-time code to scan with the {BRAND.name} app.
        </span>
      </div>
      <Button variant="primary" disabled={busy} onClick={onPair}>
        {PAIR_YOUR_PHONE}
      </Button>
    </div>
  );
}

interface CodeProps {
  code: PairingCode;
  now: number;
  busy: boolean;
  /** This Mac's Tailscale: who the phone signs in as. */
  tailscale: TailscaleState;
  /** Phones reach this Mac through the relay (signed in): no Tailscale step for the phone. */
  viaRelay?: boolean;
  /** When a device on the tailnet first reached this Mac with the code out. */
  reachedAt?: number;
  onCopy: () => void;
  onCancel: () => void;
}

export function PairCode({
  code,
  now,
  busy,
  tailscale,
  viaRelay = false,
  reachedAt,
  onCopy,
  onCancel,
}: CodeProps) {
  const left = expiresIn(code.expiresAt, now);
  return (
    <div className="phone-code" data-testid="phone-pair-code">
      <PhoneQr
        size={code.qr.size}
        modules={code.qr.modules}
        label={`Pairing code for the ${BRAND.name} phone app`}
      />
      <div className="phone-code__side">
        <span className="phone-code__title">Scan this with your phone</span>
        <ol className="phone-code__steps">
          <li>
            <span className="phone-code__step-strong">Get the {BRAND.name} app</span> on your phone,
            from your TestFlight invite.
          </li>
          {!viaRelay && (
            <li data-tailscale>
              <span className="phone-code__step-strong">{phoneTailscaleText(tailscale)}</span>{' '}
              Switch it on: it’s how the phone reaches {THIS_COMPUTER}.
              <TailscaleStoreLinks />
            </li>
          )}
          {/* The phone's own words: its buttons are "Scan the code", then "Pair". */}
          <li>
            Open {BRAND.name}, tap <span className="phone-code__step-strong">{SCAN_THE_CODE}</span>{' '}
            and point the camera at this code.
          </li>
          <li>
            Tap <span className="phone-code__step-strong">{PAIR_BUTTON}</span>, then click Allow
            here when it asks.
          </li>
        </ol>
        {reachedAt !== undefined && (
          <span className="phone-code__reached" role="status" data-testid="phone-code-reached">
            <Spinner size="sm" />A device reached {THIS_COMPUTER} at {timeOf(reachedAt)}. Waiting
            for it to send the code…
          </span>
        )}
        <span className="phone-code__expiry">{left ? `Works once, for ${left}` : 'Expired'}</span>
        <div className="phone-code__actions">
          <TextButton leftIcon={<CopyIcon size={12} />} onClick={onCopy}>
            Copy link instead
          </TextButton>
          <TextButton disabled={busy} onClick={onCancel}>
            Cancel
          </TextButton>
        </div>
      </div>
    </div>
  );
}

interface ConfirmProps {
  request: PairRequestView;
  busy: string | null;
  /** `replace`: the paired phones (by id) to remove on Allow. */
  onDecide: (allow: boolean, replace: string[]) => void;
}

const timeOf = (ms: number) => formatClock(ms);
const dayOf = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Everything the desk can say about the phone asking: the name and model it
 * gave (cleaned on the Mac), when it asked and the end of the code it used,
 * so a look-alike sent from somewhere else has something to stand out by.
 * A phone that looks like one already paired is never replaced unasked.
 */
export function PairConfirm({ request, busy, onDecide }: ConfirmProps) {
  const { device, replaces } = request;
  const meta = [
    `Asked at ${timeOf(request.requestedAt)}`,
    `code ending ${request.codeHint}`,
    ...(request.login ? [request.login] : []),
  ].join(' · ');
  return (
    <div className="phone-confirm" role="alertdialog" aria-labelledby="phone-confirm-title">
      <span className="phone-confirm__icon" aria-hidden>
        <MobileIcon size={20} />
      </span>
      <h3 id="phone-confirm-title" className="phone-confirm__title">
        Allow <strong>{device.name}</strong> to use your agents?
      </h3>
      <p className="phone-confirm__device">{deviceLine(device)}</p>
      <p className="phone-confirm__device" data-testid="phone-confirm-meta">
        {meta}
      </p>
      {replaces.length > 0 && (
        <p className="phone-confirm__warning" data-testid="phone-confirm-replaces">
          <WarningIcon size={13} />
          {replaces.length === 1
            ? `A phone called ${replaces[0].name} is already paired (since ${dayOf(replaces[0].pairedAt)}). If this is that phone again, replace it. If you don’t recognise this request, deny it.`
            : `${replaces.length} phones called ${device.name} are already paired. If this is one of them again, replace them. If you don’t recognise this request, deny it.`}
        </p>
      )}
      <p className="phone-confirm__warning">
        <WarningIcon size={13} />
        Only allow a phone you’re holding, showing the same code ending. It will be able to read and
        send messages to every agent.
      </p>
      <div className="phone-confirm__actions">
        <Button variant="secondary" disabled={busy !== null} onClick={() => onDecide(false, [])}>
          Deny
        </Button>
        {replaces.length > 0 ? (
          <>
            <Button variant="secondary" disabled={busy !== null} onClick={() => onDecide(true, [])}>
              Allow, keep both
            </Button>
            <Button
              variant="strong"
              data-allow
              disabled={busy !== null}
              onClick={() =>
                onDecide(
                  true,
                  replaces.map((d) => d.id)
                )
              }
            >
              Allow and replace
            </Button>
          </>
        ) : (
          <Button
            variant="strong"
            data-allow
            disabled={busy !== null}
            onClick={() => onDecide(true, [])}
          >
            Allow
          </Button>
        )}
      </div>
    </div>
  );
}
