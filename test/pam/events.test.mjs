/*
events.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { compileValue, resolveNote, noteNumber } from '../../src/pam/events.mjs';
import { createSetup } from '../../src/pam/midimap.mjs';

const setup = createSetup({ names: { bd: 1, bass: 5 } });
const types = (value, s = setup) => compileValue(value, s).events.map((e) => e.type);
const only = (value, s = setup) => {
  const { events, problems } = compileValue(value, s);
  assert.deepEqual(problems, []);
  assert.equal(events.length, 1, JSON.stringify(events));
  return events[0];
};

test('s plays a cell by number, by default name and by setup name', () => {
  assert.deepEqual(only({ s: 3 }), { type: 'note', cell: 3, velocity: 0.9 });
  assert.equal(only({ s: '3' }).cell, 3);
  assert.equal(only({ s: 'c7' }).cell, 7);
  assert.equal(only({ s: 'bd' }).cell, 1);
});

test('cell alone addresses and plays nothing, and with a pitch it plays', () => {
  assert.deepEqual(compileValue({ cell: 5 }, setup), { events: [], problems: [] });
  assert.deepEqual(only({ cell: 5, note: 36 }), { type: 'note', cell: 5, velocity: 0.9, note: 36 });
  assert.deepEqual(only({ cell: 'bass', n: 3 }), { type: 'note', cell: 5, velocity: 0.9, n: 3 });
});

test('cell wins over s when both name one, and s may then be any sound name', () => {
  assert.equal(only({ s: 'bd', cell: 4 }).cell, 4);
  assert.equal(only({ s: 'sawtooth', cell: 4, note: 60 }).cell, 4);
});

test('an s that names no cell, a bad cell and a note with no cell are problems, not notes', () => {
  const unknown = compileValue({ s: 'piano' }, setup);
  assert.deepEqual(unknown.events, []);
  assert.match(unknown.problems[0], /s "piano" names no cell/);
  const bad = compileValue({ cell: 9, note: 60 }, setup);
  assert.deepEqual(bad.events, []);
  assert.match(bad.problems[0], /cell 9 is not a cell/);
  const orphan = compileValue({ note: 60 }, setup);
  assert.deepEqual(orphan.events, []);
  assert.match(orphan.problems[0], /a note needs a cell/);
});

test('velocity is velocity times gain, clamped to 0..1', () => {
  assert.equal(only({ s: 1, velocity: 0.5 }).velocity, 0.5);
  assert.equal(only({ s: 1, velocity: 0.5, gain: 0.5 }).velocity, 0.25);
  assert.equal(only({ s: 1, gain: 3 }).velocity, 1);
});

test('a note at velocity 0 is a rest, and what else its hap carries still goes', () => {
  assert.deepEqual(compileValue({ s: 1, gain: 0 }, setup), { events: [], problems: [] });
  assert.deepEqual(compileValue({ s: 1, velocity: 0 }, setup), { events: [], problems: [] });
  assert.deepEqual(types({ s: 3, velocity: 0, cell_filterCutoff: 1200 }), ['knob']);
});

test('notes read as numbers and as names, in Strudel octaves', () => {
  assert.equal(noteNumber('c3'), 48);
  assert.equal(noteNumber('C3'), 48);
  assert.equal(noteNumber('eb2'), 39);
  assert.equal(noteNumber('f#4'), 66);
  assert.equal(noteNumber('a'), 57);
  assert.equal(noteNumber('60'), 60);
  assert.equal(noteNumber(61.4), 61.4);
  assert.equal(noteNumber('h3'), undefined);
  assert.equal(only({ cell: 5, note: 'eb2' }).note, 39);
  assert.equal(only({ cell: 5, freq: 440 }).note, 69);
});

test('resolveNote: a pitch as it is, n above the root, else the own note (the root when poly)', () => {
  const mono = { channel: 1, note: 50, root: 48, poly: false };
  const poly = { channel: 5, note: 52, root: 36, poly: true };
  assert.equal(resolveNote({ type: 'note', cell: 3, velocity: 1 }, mono), 50);
  assert.equal(resolveNote({ type: 'note', cell: 5, velocity: 1 }, poly), 36);
  assert.equal(resolveNote({ type: 'note', cell: 5, velocity: 1, n: 7 }, poly), 43);
  assert.equal(resolveNote({ type: 'note', cell: 5, velocity: 1, note: 60.4 }, poly), 60);
  assert.equal(resolveNote({ type: 'note', cell: 5, velocity: 1, note: 140 }, poly), 127);
});

test('cell_<name> is a knob of the hap cell, in the parameter unit', () => {
  const e = only({ cell: 3, cell_filterCutoff: 1200 });
  assert.equal(e.type, 'knob');
  assert.equal(e.param.id, 'cell3_filterCutoff');
  assert.equal(e.value, 1200);
  const hit = compileValue({ s: 'bass', cell_delayMix: 40 }, setup).events;
  assert.deepEqual(hit.map((x) => x.type), ['knob', 'note'], 's names the cell for the knob and plays it');
  assert.equal(hit[0].param.id, 'cell5_delayMix');
});

test('full ids need no cell, and a cell does not redirect them', () => {
  assert.equal(only({ cell3_delayMix: 20 }).param.id, 'cell3_delayMix');
  assert.equal(only({ macro_filterCutoff: 500 }).param.id, 'macro_filterCutoff');
  assert.equal(only({ cell: 2, cell3_delayMix: 20 }).param.id, 'cell3_delayMix');
  assert.equal(only({ crossfade: -50 }).param.id, 'crossfade');
});

test('cell_volume is the cell fader with a cell and the master volume without one', () => {
  assert.equal(only({ cell: 4, cell_volume: -6 }).param.id, 'cell4_volume');
  assert.equal(only({ cell_volume: -6 }).param.id, 'volume');
});

test('a Strudel control that shares a per-cell name is left alone', () => {
  // pan, stretch and mode are per-cell PAM parameters and Strudel controls: bare, they are Strudel's.
  assert.deepEqual(types({ s: 1, pan: 0.2, stretch: 1, mode: 'x' }), ['note']);
  assert.deepEqual(compileValue({ s: 1, pan: 0.2 }, setup).problems, []);
  assert.deepEqual(types({ s: 1, lpf: 400, room: 0.5 }), ['note']);
});

test('a per-cell knob with no cell and a name PAM lacks are named problems', () => {
  const noCell = compileValue({ cell_filterCutoff: 300 }, setup);
  assert.deepEqual(noCell.events, []);
  assert.deepEqual(noCell.problems, ['cell_filterCutoff needs a cell']);
  const typo = compileValue({ cell: 1, cell_filterCutof: 300 }, setup);
  assert.deepEqual(typo.events, []);
  assert.match(typo.problems[0], /PAM has no per-cell parameter "filterCutof"/);
});

test('out-of-range knob values clamp and say so, and unreadable ones are dropped and say so', () => {
  const high = compileValue({ cell: 1, cell_filterCutoff: 30000 }, setup);
  assert.equal(high.events[0].value, 20000);
  assert.match(high.problems[0], /cell1_filterCutoff: outside 20\.\.20000 Hz, clamped/);
  const junk = compileValue({ cell: 1, cell_filterCutoff: 'wide' }, setup);
  assert.deepEqual(junk.events, []);
  assert.match(junk.problems[0], /"wide" is not a value/);
});

test('enum knobs take their label', () => {
  assert.equal(only({ cell: 2, cell_mode: 'Loop' }).value, 2);
});

test('mute and solo are switches with a level, for the hap cell or a numbered one', () => {
  assert.deepEqual(only({ cell: 3, cell_mute: 1 }), { type: 'switch', what: 'mute', cell: 3, on: true });
  assert.deepEqual(only({ cell: 3, cell_mute: 0 }), { type: 'switch', what: 'mute', cell: 3, on: false });
  assert.deepEqual(only({ cell6_solo: 1 }), { type: 'switch', what: 'solo', cell: 6, on: true });
  assert.deepEqual(compileValue({ cell_mute: 1 }, setup).problems, ['cell_mute needs a cell']);
});

test('variation is 1-8, 0 leaves it, and anything else is a problem', () => {
  assert.deepEqual(only({ variation: 3 }), { type: 'variation', index: 3 });
  assert.deepEqual(compileValue({ variation: 0 }, setup), { events: [], problems: [] });
  assert.match(compileValue({ variation: 9 }, setup).problems[0], /variation 9 is not 1-8/);
});

test('the pattern selector sends slots and skips Off', () => {
  assert.equal(only({ cell: 2, cell_patternSelect: 4 }).value, 4);
  assert.deepEqual(compileValue({ cell: 2, cell_patternSelect: 0 }, setup), { events: [], problems: [] });
});

test('press: cell actions take the hap cell, track actions their track, rests press nothing', () => {
  assert.deepEqual(only({ cell: 3, press: 'mute' }), { type: 'press', name: 'mute', cell: 3 });
  assert.deepEqual(only({ press: 'record' }), { type: 'press', name: 'record' });
  assert.deepEqual(only({ press: ['looperMute', 2] }), { type: 'press', name: 'looperMute', arg: 2 });
  assert.match(compileValue({ press: 'mute' }, setup).problems[0], /press "mute" needs a cell/);
  assert.match(compileValue({ press: 'explode' }, setup).problems[0], /press "explode" is not an action/);
  assert.deepEqual(compileValue({ press: 0 }, setup).events, []);
});

test('plain MIDI controls pass through: program, transport, CC and NRPN', () => {
  assert.deepEqual(only({ progNum: 5 }), { type: 'preset', index: 5 });
  assert.deepEqual(only({ midicmd: 'clock' }), { type: 'transport', command: 'clock' });
  assert.deepEqual(only({ midicmd: 'midiClock' }), { type: 'transport', command: 'clock' });
  assert.deepEqual(only({ ccn: 74, ccv: 0.5, midichan: 2 }), { type: 'cc', channel: 2, cc: 74, value: 64 });
  assert.deepEqual(only({ nrpnn: 300, nrpv: 1 }), { type: 'nrpn', channel: 1, number: 300, value: 127 });
  assert.deepEqual(only({ nrpnn: [2, 44], nrpv: 0 }), { type: 'nrpn', channel: 1, number: 300, value: 0 });
  assert.match(compileValue({ midicmd: 'rewind' }, setup).problems[0], /midicmd "rewind"/);
});

test('one hap can carry knobs, a press and a note: knobs come first, the note last', () => {
  assert.deepEqual(types({ note: 'c2', cell: 5, cell_filterCutoff: 800, variation: 2, cell_cmi_p1: 0.3 }), [
    'knob',
    'knob',
    'variation',
    'note',
  ]);
});

test('non-objects compile to nothing', () => {
  assert.deepEqual(compileValue('bd', setup), { events: [], problems: [] });
  assert.deepEqual(compileValue(undefined, setup), { events: [], problems: [] });
});
