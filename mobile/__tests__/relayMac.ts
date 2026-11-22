/**
 * A Mac behind a relay, in memory and by hand: a socket class to give
 * `RelaySocket`, the Mac's half of the channel, and its session's numbering.
 * Everything happens when the test says so, on no timer.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { toBase64Url } from '@shipstudio/companion-protocol';
import { fingerprintOf } from '../src/lib/identity';
import { Cipher, deriveKeys, relayTranscript } from '../src/lib/relayCrypto';

const enc = new TextEncoder();
const dec = new TextDecoder();
const SID = 'session-1';

export function relayMac({ sessions = true } = {}) {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  const fingerprint = fingerprintOf(publicKey);
  let tx = 0;
  /** What the Mac still keeps for the phone, by number. */
  let unacked: { n: number; d: string }[] = [];
  /** Each `resume` the phone came back with. */
  const resumes: { rx: number }[] = [];
  const sockets: Socket[] = [];
  const acks: number[] = [];

  class Socket {
    binaryType = '';
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    toPhone: Cipher | null = null;
    private toMac: Cipher | null = null;

    constructor() {
      sockets.push(this);
    }
    /** The relay takes the phone; its handshake, and any session's start, follow at once. */
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
    send(data: string | Uint8Array) {
      if (typeof data === 'string') return;
      if (!this.toMac) return this.handshake(data);
      const f = JSON.parse(this.toMac.open(data)!) as { a?: number };
      if (typeof f.a !== 'number') return;
      acks.push(f.a);
      unacked = unacked.filter((u) => u.n > f.a!);
    }
    private handshake(data: Uint8Array) {
      const hello = JSON.parse(dec.decode(data)) as { e: string; resume?: { rx: number } };
      const mine = x25519.utils.randomSecretKey();
      const e = toBase64Url(x25519.getPublicKey(mine));
      const transcript = relayTranscript(hello.e, e, fingerprint);
      const shared = x25519.getSharedSecret(mine, Buffer.from(hello.e, 'base64url'));
      const keys = deriveKeys(shared, transcript);
      this.toMac = new Cipher(keys.phoneToMac);
      this.toPhone = new Cipher(keys.macToPhone);
      const signature = toBase64Url(ed25519.sign(enc.encode(transcript), secretKey));
      const answer = { v: 1, e, publicKey: toBase64Url(publicKey), signature };
      this.say(enc.encode(JSON.stringify(sessions ? { ...answer, s: 1 } : answer)));
      if (!sessions) return;
      const { resume } = hello;
      if (resume) resumes.push({ rx: resume.rx });
      this.seal(JSON.stringify({ t: 'sess', sid: SID, resumed: !!resume, rx: 0 }));
      if (!resume) return;
      unacked = unacked.filter((u) => u.n > resume.rx);
      for (const u of unacked) this.seal(JSON.stringify({ t: 'q', n: u.n, a: 0, d: u.d }));
    }
    say(bytes: Uint8Array) {
      this.onmessage?.({ data: bytes });
    }
    seal(text: string) {
      this.say(this.toPhone!.seal(text));
    }
    /** The phone closing it. */
    close() {
      this.readyState = 3;
    }
    /** The link going. */
    drop(code = 1006) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
  }

  return {
    fingerprint,
    sockets,
    acks,
    resumes,
    WebSocketImpl: Socket as unknown as typeof WebSocket,
    get socket() {
      return sockets[sockets.length - 1];
    },
    get unacked() {
      return unacked.length;
    },
    /** A protocol frame, numbered on a session. */
    frame: (d: string) => {
      const s = sockets[sockets.length - 1];
      if (!sessions) return s.seal(d);
      unacked.push({ n: ++tx, d });
      s.seal(JSON.stringify({ t: 'q', n: tx, a: 0, d }));
    },
  };
}
