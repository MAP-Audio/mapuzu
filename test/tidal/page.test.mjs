/*
page.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The page's MIDI port without a browser: a clock for the system, a clock for the page, and a
// MIDI access that records what it is sent and when.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPort } from '../../src/tidal/page.mjs';

// A browser whose page clock started at `origin` and now reads `mono`, on a machine whose system
// clock is `skew` ms ahead of what the page believes. Every look at the system clock takes `step` ms.
function browser({ origin = 1_700_000_000_000, mono = 5000, skew = 37.4, step = 0.01, outputs = ['IAC Driver Bus 1', 'Bela'] } = {}) {
  const env = { mono, sent: {} };
  const made = outputs.map((name) => ({ name, send: (bytes, at) => (env.sent[name] ??= []).push([Math.round(at * 100) / 100, ...bytes]) }));
  env.performance = { timeOrigin: origin, now: () => env.mono };
  env.Date = {
    now() {
      env.mono += step;
      return Math.floor(origin + env.mono + skew);
    },
  };
  env.access = { outputs: new Map(made.map((o) => [o.name, o])) };
  env.navigator = { requestMIDIAccess: async () => env.access };
  env.system = () => origin + env.mono + skew;
  return env;
}

test('a message is sent at its system time, as the page\'s own clock counts it', async () => {
  const env = browser();
  const port = createPort(env);
  await port.open();
  assert.ok(Math.abs(port.sync() - 37.4) < 0.02, `the page is ${port.status().skew} ms behind the system clock`);
  const due = env.system() + 250;
  const now = env.mono;
  port.play([[due, [0x90, 48, 100]], [due + 100, [0x80, 48, 0]]]);
  const [[on], [off]] = env.sent['IAC Driver Bus 1'];
  assert.ok(Math.abs(on - (now + 250)) < 0.03, `${on} is 250 ms on from ${now}`);
  assert.ok(Math.abs(off - on - 100) < 0.011);
  assert.deepEqual(port.status(), { port: 'IAC Driver Bus 1', problem: undefined, skew: port.status().skew, sent: 2, late: 0, dropped: 0 });
});

test('a page that never measured its clock would be out by the whole skew: it measures at the first message', async () => {
  const env = browser({ skew: 1500 });
  const port = createPort(env);
  await port.open();
  const now = env.mono;
  port.play([[env.system() + 100, [0x90, 48, 100]]]);
  assert.ok(Math.abs(env.sent['IAC Driver Bus 1'][0][0] - (now + 100)) < 0.05);
});

test('the clocks drift apart, and the next measurement follows them', async () => {
  const env = browser({ skew: 10 });
  const port = createPort(env);
  await port.open();
  port.sync();
  const drifted = browser({ skew: 82 });
  env.Date = { now: () => drifted.Date.now() };
  env.performance = drifted.performance;
  assert.ok(Math.abs(port.sync() - 82) < 0.02);
});

test('a message whose time has passed is sent, and counted late, and one with no port is counted dropped', async () => {
  const env = browser();
  const port = createPort(env);
  port.play([[env.system() + 10, [0x90, 48, 100]]]);
  assert.equal(port.status().dropped, 1, 'MIDI was not open yet');
  await port.open();
  port.play([[env.system() - 40, [0x90, 48, 100]]]);
  assert.equal(env.sent['IAC Driver Bus 1'].length, 1);
  assert.deepEqual([port.status().sent, port.status().late], [1, 1]);
});

test('the output is the first one, or the one named, by part of its name, and one that is not there is reported', async () => {
  const env = browser();
  const port = createPort(env);
  port.use('bela');
  await port.open();
  assert.equal(port.status().port, 'Bela', 'named before MIDI opened');
  port.use('IAC Driver Bus 1');
  assert.equal(port.status().port, 'IAC Driver Bus 1');
  port.use('Nothing Like It');
  assert.equal(port.status().port, undefined);
  assert.equal(port.status().problem, `no MIDI output named "Nothing Like It". Found: 'IAC Driver Bus 1', 'Bela'`);
  port.use('');
  assert.equal(port.status().port, 'IAC Driver Bus 1');
  // A port plugged in later is found: the browser says the list changed.
  env.access.outputs = new Map([['PAM In', { name: 'PAM In', send() {} }]]);
  env.access.onstatechange();
  assert.equal(port.status().port, 'PAM In');
});

test('a browser with no Web MIDI, an empty list, and a refusal are each reported', async () => {
  const none = createPort({ performance: { timeOrigin: 0, now: () => 0 }, Date });
  await none.open();
  assert.equal(none.status().problem, 'this browser has no Web MIDI');

  const empty = browser({ outputs: [] });
  const port = createPort(empty);
  await port.open();
  assert.match(port.status().problem, /no MIDI output found/);

  const refusing = browser();
  refusing.navigator.requestMIDIAccess = async () => {
    throw new Error('denied');
  };
  const refused = createPort(refusing);
  await refused.open();
  assert.equal(refused.status().problem, 'MIDI was refused: denied');
});
