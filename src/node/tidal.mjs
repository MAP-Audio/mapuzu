/*
tidal.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// `mapuzu tidal`: what TidalCycles' `pamTarget` sends to. It listens for Tidal's OSC on UDP and
// turns it into MIDI for PAM. Node has no MIDI of its own without a native module, so the MIDI
// port is held by a page that this serves: the browser's Web MIDI, the same way out that Strudel's
// `.pam()` uses, which takes a timestamp with every message and so keeps Tidal's timing.

import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTidalReceiver } from '../tidal/receiver.mjs';
import { TIDAL_PORT } from '../tidal/boot.mjs';
import { CORS, listenLocal } from './serve.mjs';

// How long packets are gathered before they are put in order and sent on.
const BATCH_MS = 2;
// How often a clock that has gone quiet is looked for.
const IDLE_MS = 100;

const PAGE_MODULE = fileURLToPath(new URL('../tidal/page.mjs', import.meta.url));

/** The page that holds the MIDI port: it reads MIDI messages off `/events` and plays them through src/tidal/page.mjs. */
export const TIDAL_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>mapuzu tidal</title>
<style>
  body { font: 15px/1.5 ui-monospace, Menlo, monospace; background: #1b1b1b; color: #f2f2f2; margin: 2rem; max-width: 46rem; }
  b { color: #70fbbf; } button { font: inherit; padding: .3rem .8rem; } .bad { color: #f75c5f; } li { color: #ffd818; }
</style>
<h1>mapuzu tidal</h1>
<p>This page is the MIDI port between TidalCycles and PAM. Leave it open, in a window of its own:
a browser slows a tab it has hidden.</p>
<p>MIDI out: <b id="port">none yet</b> <button id="open">open MIDI</button></p>
<p>sent <b id="sent">0</b> &middot; late <b id="late">0</b> &middot; dropped <b id="dropped">0</b></p>
<ul id="problems"></ul>
<script type="module">
  import { createPort } from './page.mjs';
  const el = (id) => document.getElementById(id);
  const port = createPort();
  function show() {
    const now = port.status();
    el('port').textContent = now.port ?? now.problem ?? 'none yet';
    el('port').className = now.port ? '' : 'bad';
    for (const key of ['sent', 'late', 'dropped']) el(key).textContent = now[key];
  }
  el('open').onclick = () => port.open().then(show);
  port.open().then(show);
  port.sync();
  // The page's clock drifts from the system's by milliseconds an hour.
  setInterval(port.sync, 10000);
  setInterval(show, 500);

  const events = new EventSource('/events');
  events.addEventListener('setup', (e) => { port.use(JSON.parse(e.data).port); show(); });
  events.addEventListener('midi', (e) => port.play(JSON.parse(e.data)));
  events.addEventListener('problem', (e) => {
    const li = document.createElement('li');
    li.textContent = JSON.parse(e.data);
    el('problems').append(li);
  });
</script>
`;

/**
 * Starts listening, on this machine only: Tidal runs here too, and its time stamps are on this
 * machine's clock.
 *
 * @param {object} [options]
 * @param {number} [options.port] the port for both: Tidal's OSC over UDP, and the page over HTTP
 *   (default 4748. 0 picks free ones, which may differ)
 * @param {object | string} [options.setup] the PAM being played, until a `pamsetup` from Tidal says otherwise
 * @param {(message: string) => void} [options.log] told each problem once
 * @param {(bytes: number[], whenMs: number) => void} [options.send] a MIDI output to use instead
 *   of the page: it is given each message and the Unix time it is due, and does its own timing
 * @returns {Promise<{ url: string, port: number, udpPort: number, receiver: object, close: () => Promise<void> }>}
 */
export async function tidal({ port = TIDAL_PORT, setup, log = () => {}, send } = {}) {
  const pages = new Set();
  let wanted = {};
  let unheard = 0;
  let warned = false;
  let url = '';
  const toPages = (event, data) => {
    for (const page of pages) page.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  let batch = [];
  const receiver = createTidalReceiver({
    setup,
    send: send ?? ((bytes, whenMs) => batch.push([whenMs, bytes])),
    log: (message) => {
      log(message);
      toPages('problem', message);
    },
    onSetup: (said) => {
      wanted = said;
      toPages('setup', said);
    },
  });
  const deliver = () => {
    receiver.flush();
    if (batch.length && !pages.size) {
      unheard += batch.length;
      if (!warned) log(`[pam] no page is open at ${url}: nothing holds the MIDI port, and Tidal's events go nowhere`);
      warned = true;
    } else if (batch.length) toPages('midi', batch);
    batch = [];
  };

  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const head = { ...CORS, 'Cache-Control': 'no-store' };
    const answer = (status, type, body) => {
      response.writeHead(status, { ...head, 'Content-Type': type });
      response.end(body);
    };
    if (request.method !== 'GET') answer(405, 'text/plain', '');
    else if (path === '/') answer(200, 'text/html; charset=utf-8', TIDAL_PAGE);
    else if (path === '/page.mjs') answer(200, 'text/javascript; charset=utf-8', await readFile(PAGE_MODULE));
    else if (path === '/status') answer(200, 'application/json', JSON.stringify({ ...receiver.status(), pages: pages.size, unheard }));
    else if (path === '/events') {
      response.writeHead(200, { ...head, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      response.write(`event: setup\ndata: ${JSON.stringify(wanted)}\n\n`);
      pages.add(response);
      warned = false;
      request.on('close', () => pages.delete(response));
    } else answer(404, 'text/plain', `mapuzu tidal has no ${path}\n`);
  });
  const http = await listenLocal(server, port);
  url = `http://localhost:${http.port}/`;

  const socket = createSocket('udp4');
  let timer;
  socket.on('message', (packet) => {
    // The system clock, as Tidal's time stamps are: Node's own high-resolution clock drifts from it.
    receiver.receive(packet, Date.now());
    // Tidal sends a frame's events as a burst: they are sent on together, in the order of their times.
    timer ??= setTimeout(() => {
      timer = undefined;
      deliver();
    }, BATCH_MS);
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, '127.0.0.1', resolve);
  });
  const idle = setInterval(() => {
    receiver.idle(Date.now());
    deliver();
  }, IDLE_MS);

  return {
    url,
    port: http.port,
    udpPort: socket.address().port,
    receiver,
    /** How many pages hold a MIDI port for this right now. */
    get pages() {
      return pages.size;
    },
    async close() {
      clearInterval(idle);
      clearTimeout(timer);
      await new Promise((done) => socket.close(done));
      await http.close();
    },
  };
}
