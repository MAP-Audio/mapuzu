/*
tidal.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// `mapuzu tidal` from the outside: OSC goes in over UDP as TidalCycles sends it, and MIDI comes out
// to the page as events, each message with the time it is due.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { tidal } from '../../src/node/tidal.mjs';
import { encodeBundle, encodeMessage } from '../../src/tidal/osc.mjs';

// One server-sent event off a stream, as `[event, data]`.
async function nextEvent(reader) {
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  const [, event, data] = /^event: (\w+)\ndata: (.*)\n\n$/.exec(text);
  return [event, JSON.parse(data)];
}

function udp(port, packet) {
  const socket = createSocket('udp4');
  return new Promise((resolve, reject) => socket.send(packet, port, '127.0.0.1', (err) => (socket.close(), err ? reject(err) : resolve())));
}

const event = (when, named) =>
  encodeBundle(when, [encodeMessage('/pam', ['pamto', { int: 1 }, 'cps', 0.5, 'cycle', 0, 'delta', 0.5, ...Object.entries(named).flat()])]);

test('Tidal\'s OSC in over UDP comes out to the page as MIDI with its time, in order', async () => {
  const said = [];
  const server = await tidal({ port: 0, setup: 'names=bd:1,sd:2 port=IAC', log: (m) => said.push(m) });
  try {
    const response = await fetch(new URL('/events', server.url));
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const reader = response.body.getReader();
    assert.deepEqual(await nextEvent(reader), ['setup', { port: 'IAC' }], 'a page that opens later is told the port that was asked for');

    const when = Date.UTC(2030, 0, 1);
    // One datagram, the later event first in it: they are put in order before they go on.
    await udp(server.udpPort, encodeBundle(when, [event(when + 500, { pam: 'sd' }), event(when, { pam: 'bd' })]));
    const [name, batch] = await nextEvent(reader);
    assert.equal(name, 'midi');
    assert.deepEqual(batch, [
      [when, [0x90, 48, 114]],
      [when + 490, [0x80, 48, 0]],
      [when + 500, [0x90, 49, 114]],
      [when + 990, [0x80, 49, 0]],
    ]);

    await udp(server.udpPort, event(when + 1000, { pamsetup: 'port=Bela' }));
    assert.deepEqual(await nextEvent(reader), ['setup', { port: 'Bela' }]);
    await udp(server.udpPort, event(when + 1000, { pam: 'nobody' }));
    const [problem, text] = await nextEvent(reader);
    assert.equal(problem, 'problem');
    assert.match(text, /s "nobody" names no cell/);
    assert.deepEqual(said, [text]);

    const status = await (await fetch(new URL('/status', server.url))).json();
    assert.deepEqual([status.pages, status.messages, status.sent, status.port, status.unheard], [1, 4, 4, 'Bela', 0]);
    await reader.cancel();
  } finally {
    await server.close();
  }
});

test('it serves the page and the module the page runs, and nothing else', async () => {
  const server = await tidal({ port: 0 });
  try {
    const page = await fetch(server.url);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(await page.text(), /import \{ createPort \} from '\.\/page\.mjs'/);
    const module = await fetch(new URL('/page.mjs', server.url));
    assert.match(module.headers.get('content-type'), /^text\/javascript/);
    assert.match(await module.text(), /export function createPort/);
    assert.equal((await fetch(new URL('/src/pam/params.mjs', server.url))).status, 404);
    assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
  } finally {
    await server.close();
  }
});

test('with no page open the events go nowhere, and that is reported once', async () => {
  const said = [];
  const server = await tidal({ port: 0, log: (m) => said.push(m) });
  try {
    await udp(server.udpPort, event(Date.now() + 300, { pam: '1' }));
    await udp(server.udpPort, event(Date.now() + 800, { pam: '1' }));
    const deadline = Date.now() + 2000;
    let status;
    do {
      await new Promise((r) => setTimeout(r, 20));
      status = await (await fetch(new URL('/status', server.url))).json();
    } while (status.unheard < 4 && Date.now() < deadline);
    assert.equal(status.unheard, 4);
    assert.equal(said.length, 1);
    assert.match(said[0], /no page is open at http:\/\/localhost:\d+\/: nothing holds the MIDI port/);
  } finally {
    await server.close();
  }
});

test('given a MIDI output of its own, it uses that and needs no page', async () => {
  const sent = [];
  const server = await tidal({ port: 0, send: (bytes, when) => sent.push([when, ...bytes]) });
  try {
    const when = Date.UTC(2030, 0, 1);
    await udp(server.udpPort, event(when, { pam: '2', velocity: 1 }));
    const deadline = Date.now() + 2000;
    while (sent.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sent, [
      [when, 0x90, 49, 127],
      [when + 490, 0x80, 49, 0],
    ]);
  } finally {
    await server.close();
  }
});
