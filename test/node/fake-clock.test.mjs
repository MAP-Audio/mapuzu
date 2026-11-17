/*
fake-clock.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The stand-in for PAM's clock output: its epoch rules, and that what it serves is what a follower reads.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createFakeClock, serveClock } from '../../src/node/fake-clock.mjs';
import { readSnapshot } from '../../src/pam/follow.mjs';

test('starting, stopping and seeking are new epochs, and a tempo change keeps the epoch and the position', () => {
  let ms = 0;
  const clock = createFakeClock({ bpm: 120, now: () => ms });
  assert.deepEqual([clock.snapshot().epoch, clock.snapshot().playing, clock.snapshot().ppq], [1, false, 0]);
  clock.play();
  ms = 1000;
  assert.deepEqual([clock.snapshot().epoch, clock.snapshot().ppq], [2, 2], 'two beats a second');
  clock.play();
  assert.equal(clock.snapshot().epoch, 2, 'playing while playing changes nothing');

  clock.setBpm(60);
  assert.deepEqual([clock.snapshot().epoch, clock.snapshot().ppq, clock.snapshot().bpm], [2, 2, 60]);
  ms = 3000;
  assert.equal(clock.snapshot().ppq, 4, 'one beat a second from where the change found it');

  clock.seek(64);
  assert.deepEqual([clock.snapshot().epoch, clock.snapshot().ppq], [3, 64]);
  clock.stop();
  ms = 9000;
  assert.deepEqual([clock.snapshot().epoch, clock.snapshot().playing, clock.snapshot().ppq], [4, false, 64], 'stopped, the position holds');
});

// One server-sent event off a stream, as text.
async function nextEvent(reader) {
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  return text;
}

test('the clock is served as events a follower reads, to any page, and pushed at each change', async () => {
  const clock = createFakeClock({ bpm: 140 });
  const server = await serveClock(clock, { port: 0, everyMs: 60000 });
  try {
    const response = await fetch(server.url);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const reader = response.body.getReader();

    const first = await nextEvent(reader);
    assert.match(first, /^data: \{.*\}\n\n$/);
    assert.deepEqual(readSnapshot(JSON.parse(first.slice(6))), {
      epoch: 1,
      playing: false,
      ppq: 0,
      bpm: 140,
      quartersPerBar: 4,
      unixMs: JSON.parse(first.slice(6)).unixMs,
      source: 'standalone',
      instance: 'fake-clock',
    });

    const sought = await (await fetch(new URL('/seek?ppq=8', server.url))).json();
    assert.deepEqual([sought.epoch, sought.ppq], [2, 8]);
    const pushed = readSnapshot(JSON.parse((await nextEvent(reader)).slice(6)));
    assert.deepEqual([pushed.epoch, pushed.ppq], [2, 8], 'the change arrives without waiting for the steady rate');

    await reader.cancel();
    assert.equal((await fetch(new URL('/nothing', server.url))).status, 404);
  } finally {
    await server.close();
  }
});
