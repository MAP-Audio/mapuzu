/*
midi.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The bytes are the whole contract with a running PAM: each test pins them against what PAM's
// MIDI code reads.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { compileValue } from '../../src/pam/events.mjs';
import { createMidiEncoder, nrpnBytes } from '../../src/pam/midi.mjs';
import { createSetup, paramNumber } from '../../src/pam/midimap.mjs';
import { resolveParam } from '../../src/pam/params.mjs';

function send(encoder, value, duration = 0.5) {
  const { events, problems } = compileValue(value, encoder.setup);
  assert.deepEqual(problems, []);
  return encoder.encode(events, duration);
}
const bytes = (messages) => messages.map((m) => m.bytes);

test('a default-setup hit is note-on then note-off of the cell note on channel 1', () => {
  const enc = createMidiEncoder();
  const out = send(enc, { s: 1 }, 0.5);
  assert.deepEqual(out, [
    { bytes: [0x90, 48, 114], at: 0 },
    { bytes: [0x80, 48, 0], at: 0.49 },
  ]);
  assert.deepEqual(bytes(send(enc, { s: 8, velocity: 1 }))[0], [0x90, 55, 127]);
});

test('the note-off leaves a gap before the next onset, and half the length for very short notes', () => {
  const enc = createMidiEncoder(createSetup(), { noteOffGap: 0.01 });
  assert.equal(send(enc, { s: 1 }, 0.25)[1].at, 0.24);
  assert.equal(send(enc, { s: 1 }, 0.012)[1].at, 0.006);
});

test('velocity never rounds a sounding note down to a note-off', () => {
  const enc = createMidiEncoder();
  assert.deepEqual(bytes(send(enc, { s: 1, velocity: 0.001 }))[0], [0x90, 48, 1]);
});

test('channel per cell: a pitched note goes to the cell channel as written', () => {
  const enc = createMidiEncoder(createSetup({ channels: 'cell', poly: [5], roots: { 5: 36 } }));
  assert.deepEqual(bytes(send(enc, { cell: 5, note: 'c2' })), [
    [0x94, 36, 114],
    [0x84, 36, 0],
  ]);
  assert.deepEqual(bytes(send(enc, { cell: 5, n: 7 }))[0], [0x94, 43, 114], 'n counts from the root');
  assert.deepEqual(bytes(send(enc, { s: 5 }))[0], [0x94, 36, 114], 'a poly cell with no pitch plays its root');
  assert.deepEqual(bytes(send(enc, { s: 2 }))[0], [0x91, 49, 114]);
});

test('a knob is one NRPN on the control channel: CC99 MSB, CC98 LSB, CC6 value', () => {
  const enc = createMidiEncoder();
  const number = paramNumber(resolveParam('cell3_filterCutoff'));
  const out = send(enc, { cell: 3, cell_filterCutoff: 1000 });
  assert.deepEqual(bytes(out), [
    [0xbf, 99, number >> 7],
    [0xbf, 98, number & 127],
    [0xbf, 6, 60],
  ]);
  assert.ok(out.every((m) => m.at === 0));
  assert.deepEqual(nrpnBytes(1, 300, 5), [
    [0xb0, 99, 2],
    [0xb0, 98, 44],
    [0xb0, 6, 5],
  ]);
});

test('a knob that repeats its MIDI value is not sent again, and a new value is', () => {
  const enc = createMidiEncoder();
  assert.equal(send(enc, { cell: 3, cell_filterCutoff: 1000 }).length, 3);
  assert.equal(send(enc, { cell: 3, cell_filterCutoff: 1000 }).length, 0);
  assert.equal(send(enc, { cell: 3, cell_filterCutoff: 1003 }).length, 0, 'same 7-bit value');
  assert.equal(send(enc, { cell: 3, cell_filterCutoff: 4000 }).length, 3);
  assert.equal(send(enc, { cell: 4, cell_filterCutoff: 4000 }).length, 3, 'another cell is another knob');
  enc.reset();
  assert.equal(send(enc, { cell: 3, cell_filterCutoff: 4000 }).length, 3);
  const loud = createMidiEncoder(createSetup(), { dedupe: false });
  assert.equal(send(loud, { volume: 0 }).length + send(loud, { volume: 0 }).length, 6);
});

test('a parameter with a CC of its own is sent as that CC', () => {
  const enc = createMidiEncoder(createSetup({ cc: 'automap' }));
  assert.deepEqual(bytes(send(enc, { macro_filterCutoff: 20000 })), [[0xb0, 6, 127]]);
  assert.equal(send(enc, { macro_delayMix: 50 }).length, 3, 'the rest still go through the map');
});

test('a knob on a note is sent before the note', () => {
  const enc = createMidiEncoder();
  const out = bytes(send(enc, { s: 1, cell_synth_p1: 1 }));
  assert.deepEqual(out.map((b) => b[0] & 0xf0), [0xb0, 0xb0, 0xb0, 0x90, 0x80]);
});

test('variation is CC16 on channel 1 with the slot from 0, sent ahead of the bar', () => {
  const enc = createMidiEncoder(createSetup(), { variationLead: 0.06 });
  assert.deepEqual(send(enc, { variation: 1 }), [{ bytes: [0xb0, 16, 0], at: -0.06 }]);
  assert.deepEqual(send(enc, { variation: 8 }), [{ bytes: [0xb0, 16, 7], at: -0.06 }]);
  // The lead it has when none is given. 60 ms was not enough for a running PAM: of eight switches
  // in one song four landed a bar late, and switches on every bar never landed at all.
  assert.equal(send(createMidiEncoder(), { variation: 2 })[0].at, -0.2);
  assert.equal(send(enc, { variation: 8 }).length, 1, 'a variation is never deduped: PAM may have moved on');
});

test('variation and preset follow the listeners when PAM was set to another source', () => {
  const enc = createMidiEncoder(
    createSetup({ listeners: { variation: { channel: 2, cc: null }, preset: { channel: 3, cc: 32 } } }),
  );
  assert.deepEqual(bytes(send(enc, { variation: 3 })), [[0xc1, 2]]);
  assert.deepEqual(bytes(send(enc, { progNum: 9 })), [[0xb2, 32, 9]]);
  assert.deepEqual(bytes(send(createMidiEncoder(), { progNum: 9 })), [[0xc0, 9]]);
});

test('mute and solo levels become toggles only when the level changes', () => {
  const enc = createMidiEncoder();
  const toggle = nrpnBytes(16, 12288 + 2 * 8 + 2, 127); // __action_cellToggleMute3
  assert.deepEqual(bytes(send(enc, { cell: 3, cell_mute: 1 })), toggle);
  assert.deepEqual(send(enc, { cell: 3, cell_mute: 1 }), []);
  assert.deepEqual(bytes(send(enc, { cell: 3, cell_mute: 0 })), toggle);
  assert.deepEqual(send(enc, { cell: 3, cell_mute: 0 }), []);
  assert.deepEqual(send(enc, { cell: 4, cell_solo: 0 }), [], 'a cell starts unmuted and unsoloed');
});

test('a mute press toggles, and the level form knows about it', () => {
  const enc = createMidiEncoder();
  assert.equal(send(enc, { cell: 3, press: 'mute' }).length, 3);
  assert.deepEqual(send(enc, { cell: 3, cell_mute: 1 }), [], 'already muted by the press');
  assert.equal(send(enc, { cell: 3, cell_mute: 0 }).length, 3);
  enc.assume('mute', 3, true);
  assert.deepEqual(send(enc, { cell: 3, cell_mute: 1 }), []);
});

test('a variation or preset switch brings back what PAM stores: knobs go out again, mutes start from none', () => {
  // Measured on a running PAM: switching variation put a muted cell and two knobs back to the variation's own.
  const enc = createMidiEncoder();
  assert.equal(send(enc, { cell: 3, cell_filterCutoff: 1200 }).length, 3);
  assert.equal(send(enc, { cell: 3, cell_mute: 1 }).length, 3, 'muted');
  assert.equal(send(enc, { cell: 3, cell_filterCutoff: 1200, cell_mute: 1 }).length, 0, 'nothing changed, nothing sent');

  send(enc, { variation: 2 });
  assert.equal(send(enc, { cell: 3, cell_mute: 0 }).length, 0, 'the switch unmuted it: a toggle now would mute it again');
  assert.equal(send(enc, { cell: 3, cell_filterCutoff: 1200 }).length, 3, 'the knob is sent again');
  assert.equal(send(enc, { cell: 3, cell_mute: 1 }).length, 3, 'and a mute that still holds is put back');

  send(enc, { progNum: 4 });
  assert.equal(send(enc, { cell: 3, cell_mute: 0 }).length, 0);
  assert.equal(send(enc, { cell: 3, cell_filterCutoff: 1200 }).length, 3);
});

test('on one event the switch comes first, whatever order its keys are in', () => {
  const enc = createMidiEncoder();
  send(enc, { cell: 3, cell_mute: 1 });
  const out = bytes(send(enc, { cell: 3, cell_mute: 1, variation: 2 }));
  assert.deepEqual(out[0], [0xb0, 16, 1]);
  assert.equal(out.length, 4, 'the switch, then the mute put back after it');
});

test('forget drops knob values and keeps mutes, and use() swaps the wiring and keeps both', () => {
  const enc = createMidiEncoder();
  send(enc, { cell: 3, cell_mute: 1, cell_filterCutoff: 1000 });
  enc.forget();
  assert.equal(send(enc, { cell: 3, cell_filterCutoff: 1000 }).length, 3, 'the knob goes out again');
  assert.deepEqual(send(enc, { cell: 3, cell_mute: 1 }), [], 'PAM still has the cell muted');
  enc.use(createSetup({ channels: 'cell', control: 9 }));
  assert.equal(enc.setup.control, 9);
  assert.deepEqual(send(enc, { cell: 3, cell_mute: 1, cell_filterCutoff: 1000 }), []);
  assert.deepEqual(bytes(send(enc, { s: 3 }))[0], [0x92, 50, 114], 'notes follow the new wiring');
  enc.reset();
  assert.equal(send(enc, { cell: 3, cell_mute: 1 }).length, 3, 'reset counts every cell as unmuted again');
});

test('looper, looper variation and resample use the fixed listeners, with PAM\'s action codes', () => {
  const enc = createMidiEncoder();
  assert.deepEqual(bytes(send(enc, { press: 'looperRecord' })), [[0xb0, 17, 0]]);
  assert.deepEqual(bytes(send(enc, { press: 'looperCapture' })), [[0xb0, 17, 4]]);
  assert.deepEqual(bytes(send(enc, { press: 'looperArm:1' })), [[0xb0, 17, 10]]);
  assert.deepEqual(bytes(send(enc, { press: 'looperMute:3' })), [[0xb0, 17, 22]]);
  assert.deepEqual(bytes(send(enc, { press: 'looperClear:8' })), [[0xb0, 17, 47]]);
  assert.deepEqual(bytes(send(enc, { press: 'looperVariation:2' })), [[0xb0, 18, 1]]);
  assert.deepEqual(bytes(send(enc, { cell: 6, press: 'resample' })), [[0xb0, 19, 6]]);
});

test('mapped actions fire with 127: stop, trigger and record', () => {
  const enc = createMidiEncoder();
  assert.deepEqual(bytes(send(enc, { cell: 2, press: 'stop' })), nrpnBytes(16, 12288 + 8 + 1, 127));
  assert.deepEqual(bytes(send(enc, { cell: 1, press: 'trigger' })), nrpnBytes(16, 12288, 127));
  assert.deepEqual(bytes(send(enc, { press: 'record' })), nrpnBytes(16, 12288 + 64, 127));
});

test('transport is the real-time bytes, and CC and NRPN pass through on their channel', () => {
  const enc = createMidiEncoder();
  assert.deepEqual(bytes(send(enc, { midicmd: 'start' })), [[0xfa]]);
  assert.deepEqual(bytes(send(enc, { midicmd: 'continue' })), [[0xfb]]);
  assert.deepEqual(bytes(send(enc, { midicmd: 'stop' })), [[0xfc]]);
  assert.deepEqual(bytes(send(enc, { midicmd: 'clock' })), [[0xf8]]);
  assert.deepEqual(bytes(send(enc, { ccn: 74, ccv: 1, midichan: 10 })), [[0xb9, 74, 127]]);
  assert.deepEqual(bytes(send(enc, { nrpnn: 300, nrpv: 0.5, midichan: 2 })), nrpnBytes(2, 300, 64));
});

test('the control channel is the setup\'s', () => {
  const enc = createMidiEncoder(createSetup({ control: 9 }));
  assert.equal(send(enc, { volume: 0 })[0].bytes[0], 0xb8);
});
