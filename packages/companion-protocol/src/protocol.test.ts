import { describe, expect, it } from 'vitest';
import {
  formatPairingLink,
  isTailnetUrl,
  negotiate,
  PAIRING_SCHEME,
  pairProofMessage,
  parsePairingLink,
  welcomeProofMessage,
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
    routes: [
      { kind: 'tailscale', url: 'https://mac.tail1234.ts.net:47443' },
      { kind: 'lan', url: 'https://192.168.1.20:47444', pin: 'b64pin' },
    ],
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

  it('needs the Mac’s identity fingerprint', () => {
    const { fingerprint: _, ...without } = link;
    expect(parsePairingLink(formatPairingLink(without as PairingLink))).toBeNull();
    expect(parsePairingLink(formatPairingLink({ ...link, fingerprint: 'short' }))).toBeNull();
  });

  // The same bytes as the Mac's `identity::pair_message` / `welcome_message`
  // (their Rust test spells out the same strings).
  it('signs exactly what the Mac signs', () => {
    expect(pairProofMessage('c', 'srv')).toBe(`${PAIRING_SCHEME}:pair:v1\nc\nsrv`);
    expect(welcomeProofMessage('c', 'srv', 'dev')).toBe(
      `${PAIRING_SCHEME}:welcome:v1\nc\nsrv\ndev`
    );
  });
});
