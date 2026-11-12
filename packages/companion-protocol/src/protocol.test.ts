import { describe, expect, it } from 'vitest';
import {
  formatPairingLink,
  isTailnetUrl,
  negotiate,
  OTHER_APP_PAIRING_SCHEME,
  PAIRING_SCHEME,
  PREVIOUS_PAIRING_SCHEME,
  hostOf,
  macProofMessage,
  pairProofMessage,
  parsePairingLink,
  readPairingLink,
  isRelayUrl,
  relayPhoneUrl,
  RELAY_CLOSE_MAC_OFFLINE,
  type PairingLink,
} from './index';

describe('negotiate', () => {
  it('picks the highest version both speak', () => {
    expect(negotiate({ min: 1, max: 3 }, { min: 2, max: 2 })).toEqual({ ok: true, version: 2 });
    expect(negotiate({ min: 1, max: 2 }, { min: 1, max: 3 })).toEqual({ ok: true, version: 2 });
  });

  it('names the side that is behind', () => {
    expect(negotiate({ min: 1, max: 1 }, { min: 2, max: 3 })).toEqual({ ok: false, update: 'app' });
    expect(negotiate({ min: 3, max: 4 }, { min: 1, max: 2 })).toEqual({ ok: false, update: 'mac' });
  });
});

describe('pairing links', () => {
  const link: PairingLink = {
    v: 1,
    code: 'K7Q2MZX4A9PL3WRT8NBV6YHC5D',
    serverId: 'srv_1',
    name: 'Julian’s MacBook Pro',
    routes: [{ kind: 'tailscale', url: 'https://mac.tail1234.ts.net:47443' }],
    fingerprint: 'Zmh6rfhivXdsj8GLjp-OIA',
  };
  const withRoute = (url: string) =>
    formatPairingLink({ ...link, routes: [{ kind: 'tailscale', url }] });

  it('round-trips, including non-ASCII names', () => {
    expect(parsePairingLink(formatPairingLink(link))).toEqual(link);
  });

  it('refuses anything that is not a usable v1 link', () => {
    expect(parsePairingLink('https://example.com')).toBeNull();
    const unpinned = { ...link, routes: [{ kind: 'lan', url: 'https://192.168.1.20:47444' }] };
    expect(parsePairingLink(formatPairingLink(unpinned as PairingLink))).toBeNull();
    expect(parsePairingLink(withRoute('http://mac.ts.net'))).toBeNull();
    expect(
      parsePairingLink(formatPairingLink({ ...link, v: 2 } as unknown as PairingLink))
    ).toBeNull();
  });

  // The audit's attack: a link that names your Mac and points anywhere else.
  it('takes a Tailscale route only on a tailnet host', () => {
    expect(parsePairingLink(withRoute('https://attacker.example.com'))).toBeNull();
    expect(parsePairingLink(withRoute('https://mac.ts.net.attacker.example'))).toBeNull();
    expect(parsePairingLink(withRoute('https://mac.tail1.ts.net:47443/../x'))).toBeNull();
    expect(parsePairingLink(withRoute('https://user@mac.tail1.ts.net'))).toBeNull();
    expect(parsePairingLink(withRoute('https://mac.tail1.ts.net:47443/'))).not.toBeNull();
    expect(isTailnetUrl('https://julians-mbp.tail1c2f3.ts.net')).toBe(true);
    expect(isTailnetUrl('https://-bad.tail1.ts.net')).toBe(false);
    // The mock Mac in development is allowed only when asked for.
    expect(parsePairingLink(withRoute('https://localhost:47443'))).toBeNull();
    expect(
      parsePairingLink(withRoute('https://localhost:47443'), {
        allowHost: (u) => u.startsWith('https://localhost:'),
      })
    ).not.toBeNull();
  });

  it('needs the Mac’s identity fingerprint, and says when the Mac is too old to have one', () => {
    const { fingerprint: _, ...without } = link;
    expect(parsePairingLink(formatPairingLink(without as PairingLink))).toBeNull();
    expect(readPairingLink(formatPairingLink(without as PairingLink))).toEqual({
      ok: false,
      problem: 'old_mac',
    });
    expect(readPairingLink(formatPairingLink({ ...link, fingerprint: 'short' }))).toEqual({
      ok: false,
      problem: 'invalid',
    });
    // An old Mac's link that is broken in some other way is just broken.
    expect(
      readPairingLink(formatPairingLink({ ...without, routes: [] } as unknown as PairingLink))
    ).toEqual({ ok: false, problem: 'invalid' });
  });

  // A Mac still on the build from before the rename makes `<old>-companion://`
  // codes: that phone app is this one, so say "update the Mac", never "not a code".
  it('names a code from the Mac’s pre-rename build, and one for the other app', () => {
    const body = formatPairingLink(link).slice(PAIRING_SCHEME.length);
    expect(PREVIOUS_PAIRING_SCHEME).toBeTruthy();
    expect(PREVIOUS_PAIRING_SCHEME).not.toBe(PAIRING_SCHEME);
    expect(readPairingLink(`${PREVIOUS_PAIRING_SCHEME}${body}`)).toEqual({
      ok: false,
      problem: 'renamed_mac',
    });
    expect(parsePairingLink(`${PREVIOUS_PAIRING_SCHEME}${body}`)).toBeNull();
    expect(readPairingLink(`${OTHER_APP_PAIRING_SCHEME}${body}`)).toEqual({
      ok: false,
      problem: 'other_app',
    });
    expect(readPairingLink(formatPairingLink(link)).ok).toBe(true);
  });

  // docs/relay.md: the relay route names the Mac it's for, on the brand's relay only.
  it('takes a relay route only on the relay host and only for the pinned Mac', () => {
    const fp = link.fingerprint;
    const relay = (url: string, options = {}) =>
      parsePairingLink(formatPairingLink({ ...link, routes: [{ kind: 'relay', url }] }), {
        relayHost: 'relay.example.app',
        ...options,
      });
    expect(relay(`wss://relay.example.app/v1/phone/${fp}`)).not.toBeNull();
    expect(relay(`wss://relay.example.app:8443/v1/phone/${fp}`)).not.toBeNull();
    // Only as the Mac writes it: nothing the URL parser would have to tidy.
    expect(relay(`wss://Relay.Example.App:443/v1/phone/${fp}`)).toBeNull();
    // Another Mac's slot, another host, not TLS, extra bits: never.
    expect(relay(`wss://relay.example.app/v1/phone/AAAAAAAAAAAAAAAAAAAAAA`)).toBeNull();
    expect(relay(`wss://attacker.example/v1/phone/${fp}`)).toBeNull();
    expect(relay(`ws://relay.example.app/v1/phone/${fp}`)).toBeNull();
    expect(relay(`wss://relay.example.app/v1/phone/${fp}?x=1`)).toBeNull();
    expect(relay(`wss://u@relay.example.app/v1/phone/${fp}`)).toBeNull();
    expect(relay(`wss://relay.example.app/v1/mac/${fp}`)).toBeNull();
    expect(relay(`wss://relay.example.app/v1/x/../phone/${fp}`)).toBeNull();
    // A build with no relay takes none, except the dev mock when asked for.
    expect(relay(`wss://relay.example.app/v1/phone/${fp}`, { relayHost: null })).toBeNull();
    expect(
      relay(`ws://localhost:4000/v1/phone/${fp}`, {
        relayHost: null,
        allowHost: (u: string) => u.startsWith('ws://localhost:'),
      })
    ).not.toBeNull();
    // Still exactly one route.
    const both = {
      ...link,
      routes: [link.routes[0], { kind: 'relay', url: `wss://relay.example.app/v1/phone/${fp}` }],
    } as PairingLink;
    expect(
      parsePairingLink(formatPairingLink(both), { relayHost: 'relay.example.app' })
    ).toBeNull();
    expect(isRelayUrl(`wss://relay.example.app/v1/phone/${fp}`, fp, { relayHost: null })).toBe(
      false
    );
    expect(relayPhoneUrl(fp, 'https://relay.example.app')).toBe(
      `wss://relay.example.app/v1/phone/${fp}`
    );
    expect(relayPhoneUrl(fp, null)).toBeNull();
    expect(RELAY_CLOSE_MAC_OFFLINE).toBe(4404);
  });

  // The confirm screen shows one host: a second, unshown route could be anyone's.
  it('carries exactly one route', () => {
    const two = {
      ...link,
      routes: [
        { kind: 'tailscale', url: 'https://julians-mbp.tail1.ts.net:47443' },
        { kind: 'tailscale', url: 'https://attacker.tail9.ts.net:47443' },
      ],
    } as PairingLink;
    expect(parsePairingLink(formatPairingLink(two))).toBeNull();
    expect(parsePairingLink(formatPairingLink({ ...link, routes: [] }))).toBeNull();
  });

  // The same bytes as the Mac's `identity::mac_message` / `pair_message`
  // (their Rust test spells out the same strings).
  it('signs exactly what the Mac signs', () => {
    expect(macProofMessage('c', 'srv', ['B.ts.net', 'a.ts.net'])).toBe(
      `${PAIRING_SCHEME}:identity:v2\nc\nsrv\na.ts.net,b.ts.net`
    );
    expect(pairProofMessage('c', 'srv', ['a.ts.net'], 'dev')).toBe(
      `${PAIRING_SCHEME}:pair:v2\nc\nsrv\na.ts.net\ndev`
    );
    // Different purposes never sign the same bytes.
    expect(macProofMessage('c', 'srv', [])).not.toBe(pairProofMessage('c', 'srv', [], ''));
  });

  it('reads a route’s host the way the Mac signs it', () => {
    expect(hostOf('https://Mac.Tail1.ts.net:47443/')).toBe('mac.tail1.ts.net');
    expect(hostOf('not a url')).toBeNull();
  });
});
