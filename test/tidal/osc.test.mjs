/*
osc.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The OSC reader against packets written byte by byte, the way Tidal's library writes them, and
// against its own writer.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { decodePacket, encodeBundle, encodeMessage, timetagToMs } from '../../src/tidal/osc.mjs';

const ascii = (text) => [...text].map((c) => c.charCodeAt(0));

test('a message is its address and its arguments by type tag, each padded to four bytes', () => {
  // "/pam" ",sif" "bd" 3 0.5, as the OSC 1.0 specification lays it out.
  const packet = new Uint8Array([
    ...ascii('/pam'), 0, 0, 0, 0,
    ...ascii(',sif'), 0, 0, 0, 0,
    ...ascii('bd'), 0, 0,
    0, 0, 0, 3,
    0x3f, 0, 0, 0,
  ]);
  assert.deepEqual(decodePacket(packet), [{ address: '/pam', args: ['bd', 3, 0.5], time: undefined }]);
  assert.deepEqual(decodePacket(Buffer.from(packet)), decodePacket(packet), 'a Node Buffer, as dgram hands it over');
});

test('a bundle gives its time tag to every message in it, as Unix milliseconds', () => {
  // 1 January 2026 00:00:00.5 UTC: 3976214400 (0xED003780) seconds after 1900, and half of 2^32.
  const head = [...ascii('#bundle'), 0, 0xed, 0x00, 0x37, 0x80, 0x80, 0, 0, 0];
  const message = encodeMessage('/pam', ['pam', 'bd']);
  const packet = new Uint8Array([...head, 0, 0, 0, message.length, ...message, 0, 0, 0, message.length, ...message]);
  const read = decodePacket(packet);
  assert.equal(read.length, 2);
  assert.equal(read[0].time, Date.UTC(2026, 0, 1) + 500);
  assert.equal(read[1].time, read[0].time);
  assert.equal(timetagToMs(0, 1), undefined, '"immediately" is no time');
});

test('the writer is read back: strings, floats, integers, and a time to the fraction of a millisecond', () => {
  const when = Date.UTC(2026, 10, 16, 12, 0, 0) + 123.25;
  const args = ['pamto', { int: 1 }, 'cycle', 12.5, 'pam', 'bd', 'pam_mode', 'Gate'];
  const [read] = decodePacket(encodeBundle(when, [encodeMessage('/pam', args)]));
  assert.deepEqual(read.args, ['pamto', 1, 'cycle', 12.5, 'pam', 'bd', 'pam_mode', 'Gate']);
  assert.ok(Math.abs(read.time - when) < 0.001, `${read.time} is ${when}`);
});

test('a packet cut short is an error, not a guess', () => {
  const whole = encodeMessage('/pam', ['cycle', 12.5]);
  assert.throws(() => decodePacket(whole.subarray(0, whole.length - 2)), /shorter than its type tags/);
  assert.throws(() => decodePacket(new Uint8Array(ascii('/pam'))), /runs off the end/);
});
