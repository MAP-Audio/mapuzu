/*
play-rtc.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// PAM's play interface over a WebRTC data channel: the way to a PAM tab from a page that the
// browser keeps apart from tabs of other sites, as it keeps strudel.cc. The two tabs meet through
// a room, a code that both know, on a small endpoint of PAM's site. After that every message goes
// straight from one tab to the other, and the messages are the ones that `postMessage` carries.
//
// It follows PAM's document ("Connecting over a data channel"): the sender makes the offer and
// the channel, PAM answers, each side sends one whole description once its addresses are
// gathered, and no server is named, because the two tabs are on one computer.

const GATHER_WAIT_MS = 5000;
// How long the channel has to open once PAM's answer is set. A browser that cannot find the other
// tab's `.local` addresses never says that it failed, so this is the only end to that wait, and
// PAM gives up after the same time.
export const CHANNEL_WAIT_MS = 15000;
// The longest the endpoint is asked to hold a request for PAM's answer, in seconds. It may hold up to 25.
const HOLD_S = 20;
/** The most that the endpoint takes in one body, and that PAM takes in one message on the channel, in bytes. */
export const MAX_BODY_BYTES = 8000;
export const MAX_MESSAGE_BYTES = 200000;
// How long to wait when the endpoint answers 429 and does not say.
const RETRY_DEFAULT_MS = 1000;

/** The size of a text in UTF-8, which is what the endpoint and PAM count. */
export const byteLength = (text) => new TextEncoder().encode(text).length;

/** A room code: 22 to 64 characters that are safe in an address. */
export const isRoom = (code) => typeof code === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(code);

/** A pairing that did not come about. `code` says at which step. */
export class PairError extends Error {
  /**
   * @param {'no_webrtc' | 'no_addresses' | 'too_large' | 'busy' | 'pairing_off' | 'signalling' | 'no_answer' | 'no_connection' | 'overtaken'} code
   * @param {string} [message]
   */
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

/**
 * A room code: 16 random bytes in base64url, 22 characters.
 * @param {{ getRandomValues: (bytes: Uint8Array) => Uint8Array }} [crypto]
 */
export function makeRoom(crypto = globalThis.crypto) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// `Retry-After` is seconds or a date. Without one, a moment.
function retryAfter(value) {
  if (value === null || value === undefined || value === '') return RETRY_DEFAULT_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : RETRY_DEFAULT_MS;
}

/**
 * The four operations of the pairing endpoint on PAM's site. The sender leaves its offer and
 * waits for the answer. PAM's page waits for the offer and leaves its answer. Nothing outside
 * this function knows an address or a body.
 *
 * Waiting is the endpoint's work: it holds a request for up to `wait` seconds until there is
 * something to give, so the page that waits runs no timer.
 *
 * @param {{ origin: string, fetch?: typeof fetch }} options `origin` is the site that serves PAM
 */
export function createSignalling({ origin, fetch = globalThis.fetch }) {
  const address = (room, what, wait) => `${origin}/api/play/v1/rooms/${encodeURIComponent(room)}/${what}${wait === undefined ? '' : `?wait=${wait}`}`;
  // The endpoint says what was wrong as { error: { code, message } }. A 429 may come without it,
  // and says in `Retry-After` how long to wait before asking again: the error carries that.
  const refused = async (response) => {
    const said = await Promise.resolve()
      .then(() => response.json())
      .catch(() => undefined);
    const code = said?.error?.code;
    const err = new Error(`it answered ${response.status}${code ? ` ${code}` : ''}`);
    Object.assign(err, { status: response.status, code });
    if (response.status === 429) err.retryAfterMs = retryAfter(response.headers?.get?.('Retry-After'));
    return err;
  };
  const leave = async (room, what, sdp, signal) => {
    const body = JSON.stringify({ sdp });
    const size = byteLength(body);
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error(`${size} bytes, and PAM's site takes ${MAX_BODY_BYTES}`), { code: 'too_large' });
    const response = await fetch(address(room, what), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, signal });
    if (!response.ok) throw await refused(response);
  };
  const take = async (room, what, wait, signal) => {
    const response = await fetch(address(room, what, wait), { signal });
    if (response.status === 204) return undefined;
    if (!response.ok) throw await refused(response);
    return response.json();
  };
  return {
    /** The sender's offer. It takes the place of an earlier one for the room. */
    putOffer: (room, sdp, signal) => leave(room, 'offer', sdp, signal),
    /** For PAM's page: `{ sdp, origin }` once an offer is there, or nothing when the wait is over. */
    getOffer: (room, wait = 0, signal) => take(room, 'offer', wait, signal),
    /** PAM's answer. */
    putAnswer: (room, sdp, signal) => leave(room, 'answer', sdp, signal),
    /** For the sender: `{ sdp }` once PAM has answered, or nothing when the wait is over. */
    getAnswer: (room, wait = 0, signal) => take(room, 'answer', wait, signal),
  };
}

// Waits `ms`, unless the pairing is stopped first.
const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const stopped = () => {
      clearTimeout(timer);
      reject(new PairError('overtaken'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stopped);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stopped, { once: true });
  });

// Resolves when `happened()` is true, looking again at each of the events, and rejects with `late`
// after `ms` or with what `happened` throws.
function until(events, happened, ms, late) {
  return new Promise((resolve, reject) => {
    const done = (settle, value) => {
      clearTimeout(timer);
      for (const [target, event] of events) target.removeEventListener(event, check);
      settle(value);
    };
    const check = () => {
      let now;
      try {
        now = happened();
      } catch (err) {
        return done(reject, err);
      }
      return now ? done(resolve) : undefined;
    };
    const timer = setTimeout(() => done(reject, late), ms);
    for (const [target, event] of events) target.addEventListener(event, check);
    check();
  });
}

/**
 * Pairs with the PAM page that listens under `room`, and resolves with the way to it.
 *
 * @param {object} options
 * @param {object} [options.env] where `RTCPeerConnection` is looked up (default `globalThis`)
 * @param {ReturnType<typeof createSignalling>} options.signalling
 * @param {string} options.room the code both pages know
 * @param {string} options.label the data channel's name, and the `channel` of every message it carries
 * @param {number} options.answerWaitMs how long PAM has to answer
 * @param {AbortSignal} [options.signal] aborted when this pairing is no longer the one wanted
 * @param {number} [options.slowAfterMs] call `onSlow` once if PAM has not answered by then
 * @param {() => void} [options.onSlow]
 * @returns {Promise<object>} a port: `post(message)`, `closed`, `close()`, and `onmessage` and
 *   `onclose` for whoever holds it to set. Rejects with a `PairError`
 */
export async function pair({ env = globalThis, signalling, room, label, answerWaitMs, signal, slowAfterMs = Infinity, onSlow = () => {} }) {
  if (typeof env.RTCPeerConnection !== 'function') throw new PairError('no_webrtc');
  // No server is named: the two tabs are on one computer, and its own addresses are all they need.
  const peer = new env.RTCPeerConnection();
  const channel = peer.createDataChannel(label);
  try {
    await peer.setLocalDescription(await peer.createOffer());
    // One whole description goes out, so it waits until the browser has found every address.
    await until([[peer, 'icegatheringstatechange']], () => peer.iceGatheringState === 'complete', GATHER_WAIT_MS, new PairError('no_addresses'));
    const asked = Date.now();
    // The endpoint may ask for a wait (429). It is kept to, for as long as this pairing has left.
    const kept = async (call) => {
      for (;;) {
        try {
          return await call();
        } catch (err) {
          if (!(err.retryAfterMs >= 0) || signal?.aborted) throw err;
          const left = asked + answerWaitMs - Date.now();
          if (err.retryAfterMs >= left) throw new PairError('busy', `PAM's site asked for a wait of ${Math.ceil(err.retryAfterMs / 1000)} s`);
          await pause(err.retryAfterMs, signal);
        }
      }
    };
    let answer;
    try {
      await kept(() => signalling.putOffer(room, peer.localDescription.sdp, signal));
      while (!answer) {
        const waited = Date.now() - asked;
        if (waited >= answerWaitMs) throw new PairError('no_answer');
        if (waited >= slowAfterMs) {
          slowAfterMs = Infinity;
          onSlow();
        }
        // The endpoint does the waiting. It is asked to hold no longer than this pairing has left.
        const hold = Math.min(HOLD_S * 1000, answerWaitMs - waited, slowAfterMs - waited);
        answer = await kept(() => signalling.getAnswer(room, Math.max(1, Math.ceil(hold / 1000)), signal));
      }
    } catch (err) {
      if (signal?.aborted) throw new PairError('overtaken');
      if (err instanceof PairError) throw err;
      if (err.code === 'too_large') throw new PairError('too_large', `this browser's description of the connection is ${err.message}`);
      if (err.code === 'pairing_off') throw new PairError('pairing_off');
      throw new PairError('signalling', err.message);
    }
    await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    const open = () => {
      if (signal?.aborted) throw new PairError('overtaken');
      if (peer.connectionState === 'failed' || peer.iceConnectionState === 'failed' || peer.connectionState === 'closed') throw new PairError('no_connection');
      return channel.readyState === 'open';
    };
    await until([[channel, 'open'], [peer, 'connectionstatechange'], [peer, 'iceconnectionstatechange']], open, CHANNEL_WAIT_MS, new PairError('no_connection'));
  } catch (err) {
    channel.close();
    peer.close();
    throw err;
  }

  const port = {
    via: 'channel',
    // PAM drops a frame that is longer: the sender splits what it sends to stay under it.
    maxBytes: MAX_MESSAGE_BYTES,
    post: (message) => channel.send(JSON.stringify(message)),
    get closed() {
      return channel.readyState !== 'open';
    },
    close() {
      channel.close();
      peer.close();
    },
    onmessage: undefined,
    onclose: undefined,
  };
  channel.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.channel === label) port.onmessage?.(message);
  });
  channel.addEventListener('close', () => port.onclose?.());
  return port;
}
