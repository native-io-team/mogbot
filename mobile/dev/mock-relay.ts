/**
 * A stand-in relay with the Mac's half in the same process (docs/relay.md),
 * so the phone's relay route runs against the mock Mac without Cloudflare or
 * the desktop.
 *
 * - The relay: `GET /v1/phone/<fingerprint>` (WebSocket). Text `ping` gets
 *   `pong`; a Mac that's away closes the socket 4404 (`mac_offline`), a
 *   signed-out one 4402 (`sign_in_needed`), as the real relay does.
 * - The Mac's half: the channel's handshake signed with the mock Mac's
 *   identity key (X25519 + HKDF + ChaCha20-Poly1305, with @noble as the
 *   phone uses), then each opened frame is served as the real Mac serves it:
 *   companion frames go to the mock's own `/v1/ws` on loopback, and
 *   `{"t":"http"}` frames to its own HTTP routes, answered as `httpRes` /
 *   `httpBody` frames in 128 KiB pieces.
 *
 * The Mac ↔ relay leg (challenge, auth, channel ids) is the relay's own and
 * is tested in services/relay; here the two halves share a process.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import {
  RELAY_CLOSE_MAC_OFFLINE,
  RELAY_CLOSE_SIGN_IN_NEEDED,
  RELAY_HTTP_CHUNK,
  relayPhonePath,
  toBase64Url,
  type RelayHttpBody,
  type RelayHttpRequest,
  type RelayHttpResponse,
} from '@shipstudio/companion-protocol';
import http from 'node:http';
import https from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import { Cipher, deriveKeys, relayTranscript } from '../src/lib/relayCrypto';

/** What the mock relay says of the Mac when a phone connects. */
export type MockRelayMac = 'online' | 'offline' | 'sign_in_needed';

export interface MockRelayOptions {
  port?: number;
  /** The Mac this relay carries phones to. */
  fingerprint: string;
  /** Signs as the Mac (the mock's `signer.prove`: the impostor key when it has one). */
  prove: (message: string) => { publicKey: string; signature: string };
  /** The mock Mac's own address (`http://localhost:<port>` or https). */
  target: () => string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bytes from a `ws` message, whatever form it came in. */
const bytesOf = (raw: unknown): Uint8Array =>
  Array.isArray(raw)
    ? new Uint8Array(Buffer.concat(raw as Buffer[]))
    : raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw as Buffer);

export function createMockRelay(opts: MockRelayOptions) {
  let mac: MockRelayMac = 'online';
  /** Phone connections still to swallow without answering (a stalled first try). */
  let stall = 0;
  /** Refuse every phone at the door, as an unreachable relay would. */
  let down = false;
  const phones = new Set<WebSocket>();
  const loopbacks = new Set<WebSocket>();
  /** Sockets taken and left unanswered (`stallNext`), destroyed on close. */
  const stalled = new Set<{ destroy(): void }>();
  let opened = 0;
  /** Phone sockets at once before 4429, as the real relay caps them (none by default). */
  let cap = Infinity;

  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (down || req.url !== relayPhonePath(opts.fingerprint)) return socket.destroy();
    if (stall > 0) {
      // Taken, and never answered: the try sits until the phone gives it up.
      stall--;
      stalled.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => stalled.delete(socket));
      return;
    }
    wss.handleUpgrade(req, socket, head, onPhone);
  });

  function onPhone(phone: WebSocket) {
    opened++;
    if (mac === 'offline') return phone.close(RELAY_CLOSE_MAC_OFFLINE, 'mac_offline');
    if (mac === 'sign_in_needed') return phone.close(RELAY_CLOSE_SIGN_IN_NEEDED, 'sign_in_needed');
    if (phones.size >= cap) return phone.close(4429, 'too_many_phones');
    phones.add(phone);
    let channel: { send: Cipher; receive: Cipher } | null = null;
    let loopback: WebSocket | null = null;
    const queued: string[] = [];
    const requests = new Map<number, { head: RelayHttpRequest; parts: Uint8Array[] }>();

    const seal = (text: string) => {
      if (channel && phone.readyState === WebSocket.OPEN) phone.send(channel.send.seal(text));
    };
    const closePhone = () => {
      // The relay closes a phone's socket for the Mac with 1000, whatever the Mac's reason.
      if (phone.readyState === WebSocket.OPEN) phone.close(1000);
    };

    phone.on('message', (raw, isBinary) => {
      if (!isBinary) {
        if (dec.decode(bytesOf(raw)) === 'ping') phone.send('pong');
        return;
      }
      const bytes = bytesOf(raw);
      if (!channel) {
        // The phone's first payload: its fresh X25519 key, answered signed by the Mac.
        let hello: { v?: unknown; e?: unknown };
        try {
          hello = JSON.parse(dec.decode(bytes)) as typeof hello;
        } catch {
          return phone.close(1002);
        }
        if (hello.v !== 1 || typeof hello.e !== 'string') return phone.close(1002);
        const secret = x25519.utils.randomSecretKey();
        const macE = toBase64Url(x25519.getPublicKey(secret));
        const transcript = relayTranscript(hello.e, macE, opts.fingerprint);
        const shared = x25519.getSharedSecret(secret, Buffer.from(hello.e, 'base64url'));
        const keys = deriveKeys(shared, transcript);
        channel = { send: new Cipher(keys.macToPhone), receive: new Cipher(keys.phoneToMac) };
        const proof = opts.prove(transcript);
        phone.send(enc.encode(JSON.stringify({ v: 1, e: macE, ...proof })));
        return;
      }
      const text = channel.receive.open(bytes);
      if (text == null) return phone.close(1002);
      let frame: { t?: unknown; id?: unknown };
      try {
        frame = JSON.parse(text) as typeof frame;
      } catch {
        return;
      }
      if (frame.t === 'http' || frame.t === 'httpBody') {
        return void onHttp(frame as RelayHttpRequest | RelayHttpBody);
      }
      // A companion frame: served by the Mac's own socket handler, on loopback.
      if (!loopback) {
        const base = opts.target().replace(/^http/, 'ws');
        loopback = new WebSocket(`${base}/v1/ws`, {
          rejectUnauthorized: false,
          headers: { 'x-mock-relay': '1' },
        });
        loopbacks.add(loopback);
        loopback.on('open', () => queued.splice(0).forEach((t) => loopback!.send(t)));
        loopback.on('message', (data) => seal(dec.decode(bytesOf(data))));
        loopback.on('close', () => {
          loopbacks.delete(loopback!);
          closePhone();
        });
        loopback.on('error', () => {});
      }
      if (loopback.readyState === WebSocket.OPEN) loopback.send(text);
      else queued.push(text);
    });
    phone.on('close', () => {
      phones.delete(phone);
      loopback?.close();
    });
    phone.on('error', () => {});

    async function onHttp(frame: RelayHttpRequest | RelayHttpBody) {
      const id = Number(frame.id);
      if (frame.t === 'http') {
        requests.set(id, { head: frame, parts: [] });
      }
      const req = requests.get(id);
      if (!req) return;
      if (typeof frame.body === 'string' && frame.body) {
        req.parts.push(new Uint8Array(Buffer.from(frame.body, 'base64url')));
      }
      if (frame.more) return;
      requests.delete(id);
      const answer = await loopbackHttp(req.head, Buffer.concat(req.parts));
      const pieces: Buffer[] = [];
      for (let at = 0; at < answer.body.length; at += RELAY_HTTP_CHUNK) {
        pieces.push(answer.body.subarray(at, at + RELAY_HTTP_CHUNK));
      }
      const res: RelayHttpResponse = {
        t: 'httpRes',
        id,
        status: answer.status,
        headers: answer.headers,
      };
      if (pieces.length) res.body = pieces[0].toString('base64url');
      if (pieces.length > 1) res.more = true;
      seal(JSON.stringify(res));
      pieces.slice(1).forEach((p, i) => {
        const more: RelayHttpBody = {
          t: 'httpBody',
          id,
          body: p.toString('base64url'),
          more: i < pieces.length - 2,
        };
        seal(JSON.stringify(more));
      });
    }
  }

  /** The request against the Mac's own HTTP server, as the real Mac calls its loopback. */
  function loopbackHttp(head: RelayHttpRequest, body: Buffer) {
    return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>(
      (resolve) => {
        const url = new URL(head.path, opts.target());
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(
          url,
          {
            method: head.method,
            headers: { ...head.headers, 'Content-Length': String(body.length) },
            rejectUnauthorized: false,
          },
          (res) => {
            const parts: Buffer[] = [];
            res.on('data', (c: Buffer) => parts.push(c));
            res.on('end', () => {
              const headers: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) {
                if (typeof v === 'string') headers[k] = v;
              }
              resolve({ status: res.statusCode ?? 502, headers, body: Buffer.concat(parts) });
            });
          }
        );
        req.on('error', () => resolve({ status: 502, headers: {}, body: Buffer.alloc(0) }));
        req.end(body);
      }
    );
  }

  let url = '';
  return {
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(opts.port ?? 0, () => {
          const { port } = server.address() as { port: number };
          url = `ws://localhost:${port}${relayPhonePath(opts.fingerprint)}`;
          resolve(url);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        phones.forEach((p) => p.terminate());
        loopbacks.forEach((l) => l.terminate());
        stalled.forEach((s) => s.destroy());
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    /** The phone's relay route: `ws://localhost:<port>/v1/phone/<fingerprint>`. */
    get url() {
      return url;
    },
    /**
     * The Mac as the relay sees it. Going offline closes every phone's
     * socket 4404, as the relay does when the Mac's own socket goes.
     */
    setMac(next: MockRelayMac) {
      mac = next;
      if (next === 'offline')
        phones.forEach((p) => p.close(RELAY_CLOSE_MAC_OFFLINE, 'mac_offline'));
    },
    /** The relay unreachable (true): every phone refused at the door, open ones cut. */
    setDown(next: boolean) {
      down = next;
      if (next) phones.forEach((p) => p.terminate());
    },
    /** At most `n` phone sockets at once, the rest closed 4429 (`Infinity`: no cap). */
    setCap(n: number) {
      cap = n;
    },
    /** The next `n` phone connections are taken and never answered. */
    stallNext(n: number) {
      stall = n;
    },
    /** Phone sockets the relay has carried to the Mac (or turned away) so far. */
    get opened() {
      return opened;
    },
    /** Drop every phone without a close handshake (a phone's network going). */
    dropAll: () => phones.forEach((p) => p.terminate()),
  };
}
