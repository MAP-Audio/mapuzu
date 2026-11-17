/*
receiver.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// TidalCycles' OSC in, MIDI out with the time each message is due. Tidal is stood in for by the
// OSC writer: every packet here is what `pamTarget` sends for the pattern named in the test.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createTidalReceiver, parseSetup, tidalValue } from '../../src/tidal/receiver.mjs';
import { encodeBundle, encodeMessage } from '../../src/tidal/osc.mjs';
import { createSetup, paramNumber, actionTarget } from '../../src/pam/midimap.mjs';
import { resolveParam, toMidi7 } from '../../src/pam/params.mjs';

const T0 = Date.UTC(2026, 10, 16, 12);
// 120 BPM in 4/4: a cycle is two seconds.
const CPS = 0.5;

// One event as Tidal sends it: named arguments with the mark, its cycle, cps and length in seconds (a quarter
// of a cycle unless given), in a bundle stamped `ms` after T0.
const event = (ms, named, { cycle = 0, delta = 0.5 } = {}) =>
  encodeBundle(T0 + ms, [
    encodeMessage('/pam', ['pamto', { int: 1 }, 'cps', CPS, 'cycle', cycle, 'delta', delta, ...Object.entries(named).flat()]),
  ]);

function rig(setup, options = {}) {
  const sent = [];
  const said = [];
  const receiver = createTidalReceiver({ send: (bytes, when) => sent.push([Math.round((when - T0) * 1000) / 1000, ...bytes]), setup, log: (m) => said.push(m), ...options });
  const play = (...packets) => {
    packets.forEach((packet) => receiver.receive(packet, T0));
    receiver.flush();
    return sent.splice(0);
  };
  return { receiver, play, said };
}

const nrpn = (number, value, channel = 16) => {
  const status = 0xb0 | (channel - 1);
  return [[status, 99, number >> 7], [status, 98, number & 0x7f], [status, 6, value]];
};

test('tidalValue: Tidal\'s names and units become the value map src/pam reads', () => {
  const read = (...args) => tidalValue(['cps', CPS, 'delta', 0.5, ...args]);
  assert.deepEqual(read('pam', 'bd').value, { s: 'bd' });
  assert.equal(read('note', 0).value.note, 60, 'note "c5" is 0 in Tidal and middle C');
  assert.equal(read('note', -24).value.note, 36);
  assert.equal(read('midinote', 36).value.note, 36);
  assert.deepEqual(read('n', 3, 'cell', '5').value, { n: 3, cell: '5' });
  assert.deepEqual(read('pam_filterCutoff', 800, 'pam_macro_filterCutoff', 900, 'pam_cell3_delayMix', 40).value, {
    cell_filterCutoff: 800,
    macro_filterCutoff: 900,
    cell3_delayMix: 40,
  });
  assert.deepEqual(read('pam_mute', 1).value, { cell_mute: 1 });
  assert.deepEqual(read('pam_volume', -6).value, { cell_volume: -6 }, 'the cell\'s fader on a cell, the master\'s without one');
  assert.deepEqual(read('midichan', 0, 'ccn', 30, 'ccv', 127).value, { midichan: 1, ccn: 30, ccv: 1 }, 'Tidal counts channels from 0 and controllers to 127');
  assert.deepEqual(read('midicmd', 'midiClock').value, { midicmd: 'midiClock' });
  assert.deepEqual(read('midicmd', 'noteOn').value, {}, 'SuperDirt\'s own commands are not PAM\'s');
  assert.deepEqual(read('pan', 0.2, 'cutoff', 300, 's', 'bd').value, {}, 'what is not PAM\'s is left out, `s` too');

  assert.equal(read().seconds, 0.5);
  assert.equal(read('legato', 0.5).seconds, 0.25);
  assert.equal(read('legato', 0.5, 'sustain', 2).seconds, 2, 'sustain is seconds, and wins');
  assert.equal(read().steps, 0.25, 'half a second at half a cycle a second');
  assert.deepEqual(read('pam_filtercutoff', 1).problems, ['knob "filtercutoff": PAM has no parameter of that name']);
});

test('pam "bd*4": a cell by name is its note, held a gap short of the event, at the bundle\'s time', () => {
  const { play } = rig({ names: { bd: 1, sd: 2 } });
  assert.deepEqual(play(event(300, { pam: 'bd' }), event(800, { pam: 'sd', velocity: 0.5 })), [
    [300, 0x90, 48, 114],
    [790, 0x80, 48, 0],
    [800, 0x90, 49, 64],
    [1290, 0x80, 49, 0],
  ]);
});

test('note "c3 ef3" # pam "acid" # legato 0.5: a poly cell on its own channel plays the pitch for half the step', () => {
  const { play } = rig('channels=cell poly=5 roots=5:36 names=acid:5');
  assert.deepEqual(play(event(0, { note: -24, pam: 'acid', legato: 0.5 }), event(500, { note: -21, pam: 'acid', legato: 0.5 })), [
    [0, 0x94, 36, 114],
    [240, 0x84, 36, 0],
    [500, 0x94, 39, 114],
    [740, 0x84, 39, 0],
  ]);
});

test('n "0 3" # pam "chop": steps above the cell\'s root', () => {
  const { play } = rig({ poly: [4], roots: { 4: 60 }, names: { chop: 4 } });
  assert.deepEqual(play(event(0, { n: 0, pam: 'chop' }), event(500, { n: 3, pam: 'chop' })).filter((m) => m[1] === 0x90), [
    [0, 0x90, 60, 114],
    [500, 0x90, 63, 114],
  ]);
});

test('knob "filterCutoff" # cell "3": the mapped NRPN, once per value, and knobS takes the names', () => {
  const { play } = rig();
  const cutoff = resolveParam('cell3_filterCutoff');
  const mode = resolveParam('cell2_mode');
  assert.deepEqual(play(event(0, { pam_filterCutoff: 1000, cell: '3' }), event(500, { pam_filterCutoff: 1000, cell: '3' }), event(1000, { pam_mode: 'Gate', cell: '2' })), [
    ...nrpn(paramNumber(cutoff), toMidi7(cutoff, 1000)).map((bytes) => [0, ...bytes]),
    ...nrpn(paramNumber(mode), toMidi7(mode, mode.min + mode.labels.indexOf('Gate'))).map((bytes) => [1000, ...bytes]),
  ]);
});

test('a knob on a note is sent before it, at the same time', () => {
  const { play } = rig({ names: { hh: 3 } });
  const sent = play(event(0, { pam: 'hh', pam_synth_p2: 0.34 }));
  assert.deepEqual(sent.map((m) => m[1] >> 4), [0xb, 0xb, 0xb, 0x9, 0x8]);
  assert.deepEqual(sent.slice(0, 4).map((m) => m[0]), [0, 0, 0, 0]);
});

test('variation: sent 200 ms ahead, and first of its time, so the mute set with it is sent after it', () => {
  const { play } = rig({ names: { hh: 3 } });
  const toggle = nrpn(actionTarget('mute', 3).number, 127);
  assert.deepEqual(play(event(0, { pam_mute: 1, cell: 'hh' })), toggle.map((bytes) => [0, ...bytes]));
  // The same bar, in the order Tidal happened to send them: the mute, then the switch.
  const sent = play(event(2000, { pam_mute: 1, cell: 'hh' }), event(2000, { variation: { int: 2 } }));
  assert.deepEqual(sent[0], [1800, 0xb0, 16, 1], 'CC 16, variation 2, before the bar');
  assert.deepEqual(sent.slice(1), toggle.map((bytes) => [2000, ...bytes]), 'PAM brought the variation\'s mutes back: the mute goes out again');
});

test('events are sent in the order of their times, whatever order the packets came in', () => {
  const { play } = rig();
  const sent = play(event(500, { pam_filterCutoff: 300, cell: '1' }), event(0, { pam_filterCutoff: 300, cell: '1' }));
  assert.deepEqual([...new Set(sent.map((m) => m[0]))], [0], 'the earlier one is sent, and the later one repeats it and is left out');
});

test('latency moves every message, and an event with no time tag is due when it arrives', () => {
  const { play, receiver } = rig('latency=0.05');
  assert.deepEqual(play(event(100, { pam: '1' })).map((m) => m[0]), [150, 640]);
  receiver.receive(encodeMessage('/pam', ['pamto', { int: 1 }, 'cps', CPS, 'delta', 0.5, 'pam', '1']), T0 + 7000);
  assert.deepEqual(play().map((m) => m[0]), [7050, 7540]);
});

test('what is not marked for PAM, or not at /pam, is not played', () => {
  const { play, receiver } = rig();
  const unmarked = encodeBundle(T0, [encodeMessage('/pam', ['cps', CPS, 'delta', 0.25, 'pam', '1'])]);
  const elsewhere = encodeBundle(T0, [encodeMessage('/dirt/play', ['pamto', { int: 1 }, 'pam', '1', 's', 'bd'])]);
  assert.deepEqual(play(unmarked, elsewhere), []);
  assert.equal(receiver.status().ignored, 2);
  assert.deepEqual(play(new Uint8Array([1, 2, 3])), [], 'and a packet that is not OSC is a problem, not a crash');
  assert.match(receiver.status().problems[0], /OSC/);
});

// pamclock: 96 ticks a cycle, each a 96th of a cycle long.
const tick = (n, ms) => event(ms, { midicmd: 'midiClock' }, { cycle: n / 96, delta: 1 / 96 / CPS });

test('pamclock: Start with the first tick of cycle 0, then ticks', () => {
  const { play } = rig();
  assert.deepEqual(play(tick(0, 0), tick(1, 20.833), tick(2, 41.667)), [
    [0, 0xfa],
    [0, 0xf8],
    [20.833, 0xf8],
    [41.667, 0xf8],
  ]);
});

test('pamclock added mid-song waits for a sixteenth, and joins with a song position and Continue', () => {
  const { play } = rig();
  // Cycle 2 and 5 ticks: no sixteenth yet. A sixteenth is six ticks; cycle 2 and 6 ticks is the 33rd.
  assert.deepEqual(play(tick(197, 0), tick(198, 20), tick(199, 40)), [
    [20, 0xf2, 33, 0],
    [20, 0xfb],
    [20, 0xf8],
    [40, 0xf8],
  ]);
});

test('a clock that goes quiet is stopped, with all notes off where notes went, and once pamstop does it at once', () => {
  const { play, receiver } = rig({ channels: 'cell' });
  play(tick(0, 0), event(0, { pam: '3' }));
  receiver.idle(T0 + 400);
  assert.deepEqual(play(), [], 'still within reach of the next tick');
  receiver.idle(T0 + 600);
  assert.deepEqual(play(), [
    [600, 0xb2, 123, 0],
    [600, 0xfc],
  ]);
  assert.equal(receiver.status().clocked, false);

  play(tick(0, 5000));
  assert.deepEqual(play(event(5100, { midicmd: 'stop' })), [
    [5100, 0xb2, 123, 0],
    [5100, 0xfc],
  ]);
  // Asked for, a stop goes out even when no clock was running here: PAM may have been started by hand.
  assert.deepEqual(rig().play(event(0, { midicmd: 'stop' })), [[0, 0xfc]]);
});

test('once $ pamsetup "...": describes PAM from Tidal, and a setup that cannot be keeps the last one', () => {
  const { play, receiver, said } = rig();
  play(event(0, { pamsetup: 'channels=cell names=kick:2 port=IAC Driver Bus 1' }));
  assert.equal(receiver.status().port, 'IAC Driver Bus 1');
  assert.deepEqual(play(event(100, { pam: 'kick' }))[0], [100, 0x91, 49, 114]);
  play(event(200, { pamsetup: 'names=kick:9' }));
  assert.match(said.at(-1), /name "kick" points at cell 9/);
  assert.deepEqual(play(event(300, { pam: 'kick' }))[0], [300, 0x91, 49, 114]);
});

test('parseSetup: key=value pairs, or the same thing as JSON', () => {
  const said = parseSetup('channels=cell poly=5,7,8 roots=5:36,7:60 notes=1:36 names=bd:1,cp:2 control=15 cc=automap port=IAC Driver Bus 1 latency=0.02 muted=3,4 soloed=');
  assert.deepEqual(said, {
    channels: 'cell',
    poly: [5, 7, 8],
    roots: { 5: 36, 7: 60 },
    notes: { 1: 36 },
    names: { bd: 1, cp: 2 },
    control: 15,
    cc: 'automap',
    port: 'IAC Driver Bus 1',
    latency: 0.02,
    muted: [3, 4],
    soloed: [],
  });
  const { port, latency, muted, soloed, ...rest } = said;
  assert.equal(createSetup(rest).cells[4].root, 36);
  assert.deepEqual(parseSetup('channels=3 roots=48'), { channels: 3, roots: 48 });
  assert.deepEqual(parseSetup('{"channels":"cell","names":{"bd":1}}'), { channels: 'cell', names: { bd: 1 } });
  assert.throws(() => parseSetup('chanels=cell'), /"chanels" is not one of/);
  assert.throws(() => parseSetup('cell everything'), /not key=value/);
  assert.throws(() => parseSetup('poly=five'), /"five" is not a number/);
});

test('a problem is reported once, and a receiver with nowhere to send is refused', () => {
  const { play, said } = rig();
  play(event(0, { pam: 'nobody' }), event(500, { pam: 'nobody' }));
  assert.equal(said.length, 1);
  assert.match(said[0], /s "nobody" names no cell/);
  assert.throws(() => createTidalReceiver({}), /needs somewhere to send MIDI/);
});
