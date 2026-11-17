/*
fake-clock.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// A stand-in for PAM's clock output: a transport that only counts, served the
// way PAM serves its own, so `pamsetup({ follow: true })` can be tried and tested with no PAM
// running. The snapshot it sends is the wire format that a follower reads, and a PAM must send the same.

import { createServer } from 'node:http';
import { CLOCK_FEED_URL, CLOCK_VERSION } from '../pam/follow.mjs';
import { CORS, listenLocal } from './serve.mjs';

export const CLOCK_PORT = Number(new URL(CLOCK_FEED_URL).port);

const wallClock = () => performance.timeOrigin + performance.now();

/**
 * A transport with PAM's rules for its epoch: starting, stopping and seeking are discontinuities,
 * and a tempo change is not.
 *
 * @param {object} [options]
 * @param {number} [options.bpm] default 120
 * @param {[number, number]} [options.timeSig] default 4/4
 * @param {() => number} [options.now] wall-clock milliseconds (default: this machine's)
 */
export function createFakeClock({ bpm = 120, timeSig = [4, 4], now = wallClock } = {}) {
  let epoch = 1;
  let playing = false;
  let anchorPpq = 0;
  let anchorMs = now();
  const listeners = new Set();

  const ppqAt = (ms) => (playing ? anchorPpq + ((ms - anchorMs) / 60000) * bpm : anchorPpq);
  const anchor = (ppq, ms) => {
    anchorPpq = ppq;
    anchorMs = ms;
  };
  const changed = () => listeners.forEach((listener) => listener());

  return {
    /** The snapshot for one instant, as it goes on the wire. */
    snapshot(ms = now()) {
      return {
        version: CLOCK_VERSION,
        instance: 'fake-clock',
        product: 'PAM',
        epoch,
        source: 'standalone',
        playing,
        ppq: ppqAt(ms),
        bpm,
        timeSig,
        sampleRate: 48000,
        samplePos: Math.round((ppqAt(ms) / bpm) * 60 * 48000),
        monotonicUs: Math.round(performance.now() * 1000),
        unixMs: ms,
      };
    },
    play() {
      if (playing) return;
      anchor(anchorPpq, now());
      playing = true;
      epoch++;
      changed();
    },
    stop() {
      if (!playing) return;
      anchor(ppqAt(now()), now());
      playing = false;
      epoch++;
      changed();
    },
    seek(ppq) {
      anchor(ppq, now());
      epoch++;
      changed();
    },
    setBpm(next) {
      const ms = now();
      anchor(ppqAt(ms), ms);
      bpm = next;
      changed();
    },
    /** Calls `listener` after every change. Returns a function that stops the calls. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Serves a clock as PAM does: `GET /clock` is a stream of server-sent events, one snapshot each,
 * sent at every change and a few times a second besides. `/now` answers one snapshot. `/play`,
 * `/stop`, `/seek?ppq=8` and `/bpm?value=140` move the fake transport, for trying things by hand.
 *
 * @param {ReturnType<typeof createFakeClock>} clock
 * @param {object} [options]
 * @param {number} [options.port] default 9836. 0 picks a free one
 * @param {number} [options.everyMs] the steady rate (default 250)
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function serveClock(clock, { port = CLOCK_PORT, everyMs = 250 } = {}) {
  const streams = new Set();
  const event = () => `data: ${JSON.stringify(clock.snapshot())}\n\n`;
  const push = () => {
    const message = event();
    streams.forEach((stream) => stream.write(message));
  };
  const unsubscribe = clock.onChange(push);
  const timer = setInterval(push, everyMs);

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'OPTIONS') return response.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET' }).end();
    if (url.pathname === '/clock') {
      response.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      response.write(event());
      streams.add(response);
      request.on('close', () => streams.delete(response));
      return undefined;
    }
    const moves = {
      '/now': () => {},
      '/play': () => clock.play(),
      '/stop': () => clock.stop(),
      '/seek': () => clock.seek(Number(url.searchParams.get('ppq') ?? 0)),
      '/bpm': () => clock.setBpm(Number(url.searchParams.get('value'))),
    };
    const move = moves[url.pathname];
    if (!move) return response.writeHead(404, CORS).end();
    move();
    return response.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }).end(`${JSON.stringify(clock.snapshot())}\n`);
  });

  const { port: bound, close } = await listenLocal(server, port);
  return {
    url: `http://127.0.0.1:${bound}/clock`,
    port: bound,
    close: () => {
      clearInterval(timer);
      unsubscribe();
      return close();
    },
  };
}
