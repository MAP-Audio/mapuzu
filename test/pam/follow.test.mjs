/*
follow.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The follower's arithmetic against hand-computed positions. Time is a number the test chooses.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CLOCK_VERSION, createFollower, readSnapshot } from '../../src/pam/follow.mjs';

// 120 BPM in 4/4: one bar is 2 s, PAM's tempo is 0.5 cycles per second.
const wire = (over = {}) => ({ version: CLOCK_VERSION, epoch: 1, playing: true, ppq: 0, bpm: 120, timeSig: [4, 4], unixMs: 1000, ...over });
const heard = (follower, over = {}, at = 1000) => follower.onSnapshot(readSnapshot(wire(over)), at);

test('readSnapshot takes what a follower needs and names what is wrong', () => {
  assert.deepEqual(readSnapshot(wire({ ppq: 6, source: 'host', instance: 'a1', samplePos: 9 })), {
    epoch: 1,
    playing: true,
    ppq: 6,
    bpm: 120,
    quartersPerBar: 4,
    unixMs: 1000,
    source: 'host',
    instance: 'a1',
  });
  assert.equal(readSnapshot(wire({ timeSig: [6, 8] })).quartersPerBar, 3);
  assert.equal(readSnapshot(wire({ playing: 1 })).playing, false, 'playing is a boolean on the wire');
  assert.throws(() => readSnapshot(wire({ version: 2 })), /version 2: this reads version 1/);
  assert.throws(() => readSnapshot(wire({ ppq: undefined })), /ppq is undefined/);
  assert.throws(() => readSnapshot(wire({ unixMs: '1000' })), /unixMs is "1000"/);
  assert.throws(() => readSnapshot(wire({ bpm: 0 })), /bpm is 0/);
  assert.throws(() => readSnapshot(wire({ timeSig: [4, 0] })), /timeSig is \[4,0\]/);
  assert.throws(() => readSnapshot(null), /is an object/);
});

test('before PAM is heard there is nothing to follow', () => {
  const follower = createFollower();
  assert.equal(follower.cps(), undefined);
  assert.equal(follower.onHap({ cycle: 0, unixMs: 1000, version: 0, cps: 0.5 }), undefined);
  assert.deepEqual(follower.position(), { offset: 0, version: 0 });
  assert.deepEqual(follower.status(), { following: false });
});

test('the first hap at PAM\'s tempo moves the pattern to PAM\'s bar, and is left out', () => {
  const follower = createFollower();
  heard(follower, { ppq: 40 }); // bar 10 at 1000 ms
  assert.equal(follower.cps(), 0.5);
  // A hap at the pattern's cycle 0, due 500 ms later: PAM is then at bar 10.25.
  const first = follower.onHap({ cycle: 0, unixMs: 1500, version: 0, cps: 0.5 });
  assert.deepEqual(first, { cps: 0.5, astray: true });
  assert.deepEqual(follower.position(), { offset: 10.25, version: 1 });
  // The next one is queried with that offset: its pattern cycle is PAM's bar, to the millisecond.
  const next = follower.onHap({ cycle: 10.5, unixMs: 2000, version: 1, cps: 0.5 });
  assert.deepEqual(next, { cps: 0.5, astray: false });
  assert.equal(follower.status().errorMs, 0);
  assert.equal(follower.status().jumps, 1);
});

test('a hap scheduled at another tempo sets the tempo and waits to move the position', () => {
  const follower = createFollower();
  heard(follower, { ppq: 40, bpm: 140 });
  const pamCps = 140 / 240;
  assert.deepEqual(follower.onHap({ cycle: 0, unixMs: 1500, version: 0, cps: 0.5 }), { cps: pamCps, astray: true });
  assert.deepEqual(follower.position(), { offset: 0, version: 0 }, 'a hap timed by the old tempo gives no exact position');
  const moved = follower.onHap({ cycle: 0.25, unixMs: 1500, version: 0, cps: pamCps });
  assert.equal(moved.astray, true);
  assert.equal(follower.position().version, 1);
});

test('a few milliseconds are closed by tempo, toward PAM, and no further than the limit', () => {
  const follower = createFollower({ gain: 0.5, maxTrim: 0.03 });
  heard(follower);
  follower.onHap({ cycle: 0, unixMs: 1000, version: 0, cps: 0.5 });
  const { version } = follower.position();
  // Due at 3010 ms, where PAM is 10 ms past bar 1: the pattern is 10 ms behind, so it runs faster.
  heard(follower, { ppq: 4, unixMs: 3000 }, 3000);
  const behind = follower.onHap({ cycle: 1, unixMs: 3010, version, cps: 0.5 });
  assert.equal(behind.astray, false);
  assert.equal(follower.status().trim, 0.005);
  assert.equal(behind.cps, 0.5 * 1.005);
  assert.ok(Math.abs(follower.status().errorMs - 10) < 1e-9);
  heard(follower, { ppq: 8, unixMs: 5000 }, 5000);
  const ahead = follower.onHap({ cycle: 2, unixMs: 4990, version, cps: 0.5 });
  assert.equal(ahead.cps, 0.5 * 0.995);
  // 39 ms is under the jump (40 ms) and would ask for 1.95 % at this gain, but a smaller limit holds it.
  const limited = createFollower({ gain: 0.5, maxTrim: 0.01 });
  heard(limited);
  limited.onHap({ cycle: 0, unixMs: 1000, version: 0, cps: 0.5 });
  heard(limited, { ppq: 4, unixMs: 3000 }, 3000);
  assert.equal(limited.onHap({ cycle: 1, unixMs: 3039, version: 1, cps: 0.5 }).cps, 0.5 * 1.01);
  assert.equal(limited.position().version, 1, 'no move');
});

test('a new epoch moves the position again, and haps read before the move are left out', () => {
  const follower = createFollower();
  heard(follower);
  follower.onHap({ cycle: 0, unixMs: 1000, version: 0, cps: 0.5 });
  assert.deepEqual(follower.position(), { offset: 0, version: 1 });
  heard(follower, { epoch: 2, ppq: 400, unixMs: 5000 }, 5000); // PAM was sought to bar 100
  const seeking = follower.onHap({ cycle: 2.5, unixMs: 6000, version: 1, cps: 0.5 });
  assert.equal(seeking.astray, true);
  assert.deepEqual(follower.position(), { offset: 98, version: 2 }, 'bar 100.5 minus cycle 2.5');
  assert.equal(follower.onHap({ cycle: 2.75, unixMs: 6500, version: 1, cps: 0.5 }).astray, true, 'read at the old position');
  assert.equal(follower.onHap({ cycle: 100.75, unixMs: 6500, version: 2, cps: 0.5 }).astray, false);
  assert.equal(follower.status().jumps, 2);
});

test('a jump further than the tempo may close moves the position without a new epoch', () => {
  const follower = createFollower({ jump: 0.04 });
  heard(follower);
  follower.onHap({ cycle: 0, unixMs: 1000, version: 0, cps: 0.5 });
  heard(follower, { ppq: 4, unixMs: 3000 }, 3000);
  const late = follower.onHap({ cycle: 1, unixMs: 3062.5, version: 1, cps: 0.5 });
  assert.equal(late.astray, true);
  assert.equal(follower.position().version, 2);
  assert.equal(follower.position().offset, 0.03125, '62.5 ms at 0.5 cycles per second');
});

test('a stopped PAM gives its tempo and no position: the pattern plays on', () => {
  const follower = createFollower();
  heard(follower, { playing: false, ppq: 12, bpm: 90 });
  const hap = follower.onHap({ cycle: 3, unixMs: 9000, version: 0, cps: 0.5 });
  assert.deepEqual(hap, { cps: 90 / 240, astray: false });
  assert.deepEqual(follower.position(), { offset: 0, version: 0 });
});

test('a playing PAM that went quiet is not followed', () => {
  const follower = createFollower({ staleMs: 2000 });
  heard(follower, {}, 1000);
  assert.ok(follower.onHap({ cycle: 0, unixMs: 3100, version: 0, cps: 0.5, nowMs: 2900 }), 'heard 1.9 s ago; the hap is due later');
  assert.equal(follower.onHap({ cycle: 1, unixMs: 3200, version: 1, cps: 0.5, nowMs: 3100 }), undefined);
});

test('a cycle can be other than a bar, and the offset stays on a grid a double holds exactly', () => {
  const follower = createFollower({ quartersPerCycle: 2 });
  heard(follower, { ppq: 7.3 });
  assert.equal(follower.cps(), 1);
  follower.onHap({ cycle: 0, unixMs: 1000, version: 0, cps: 1 });
  const { offset } = follower.position();
  assert.ok(Math.abs(offset - 3.65) < 1 / 65536);
  assert.equal((offset * 65536) % 1, 0);
});

test('a PAM that is not rendering in real time reports where it is and is not followed', () => {
  const follower = createFollower();
  heard(follower, { source: 'offline', ppq: 40 });
  assert.equal(follower.cps(), undefined);
  assert.equal(follower.onHap({ cycle: 0, unixMs: 1000, version: 0, cps: 0.5 }), undefined);
  assert.deepEqual(follower.position(), { offset: 0, version: 0 });
});
