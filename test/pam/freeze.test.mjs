/*
freeze.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { compileValue } from '../../src/pam/events.mjs';
import { createSetup } from '../../src/pam/midimap.mjs';
import { freeze, patternClock, songFor } from '../../src/pam/freeze.mjs';

const setup = createSetup({ channels: 'cell', poly: [5], roots: { 5: 36 }, notes: [48, 49, 50, 51, 52, 53, 54, 55] });
// A timeline entry from a value map, the way the Strudel side makes them.
const at = (beat, beats, value) => ({ beat, beats, events: compileValue(value, setup).events });

test('patternClock: the fastest speed whose 32 pattern beats hold the stretch', () => {
  assert.deepEqual(patternClock(4), { speed: 9, slow: 1, length: 4 });
  assert.deepEqual(patternClock(32), { speed: 9, slow: 1, length: 32 });
  assert.deepEqual(patternClock(33), { speed: 8, slow: 2, length: 17 });
  assert.deepEqual(patternClock(100), { speed: 6, slow: 4, length: 25 });
  assert.deepEqual(patternClock(352), { speed: 2, slow: 12, length: 30 });
  assert.deepEqual(patternClock(1024), { speed: 0, slow: 32, length: 32 });
  assert.throws(() => patternClock(1025), /do not fit one PAM pattern: the longest is 1024 beats/);
});

test('notes go to the cell lane with exact times, on a clock a bar longer than the stretch', () => {
  const { delta, report } = freeze([at(0, 1, { s: 1 }), at(1.5, 0.5, { s: 1, velocity: 0.5 }), at(2 + 1 / 3, 1 / 3, { s: 1 })], { beats: 4, setup });
  // 4 beats + the guard bar = 8 beats: speed 1, length 8.
  assert.equal(delta.cell1_patternLength, 8);
  assert.equal(delta.cell1_patternSpeed, 9);
  assert.deepEqual(delta.cell1_midiSequence, [
    { time: 0, duration: 0.984375, note: 48, velocity: 114 },
    { time: 1.5, duration: 0.484375, note: 48, velocity: 64 },
    { time: 2.333333, duration: 0.317708, note: 48, velocity: 114 },
  ]);
  assert.equal(delta.cell1_patternSwing, 0);
  assert.equal(delta.cell1_patternDirection, 0);
  assert.deepEqual(delta.cells, { 1: { stepPropertyMode: 0 } });
  assert.equal(report.cells[1].notes, 3);
});

test('a long stretch slows the pattern down and scales times and lengths with it', () => {
  // 64 beats + guard = 68 -> speed 1/3 (slow 3), length 23.
  const { delta } = freeze([at(0, 1, { s: 1 }), at(60, 2, { s: 1 })], { beats: 64, setup });
  assert.equal(delta.cell1_patternSpeed, 7);
  assert.equal(delta.cell1_patternLength, 23);
  assert.deepEqual(delta.cell1_midiSequence.map((n) => n.time), [0, 20]);
  assert.equal(delta.cell1_midiSequence[1].duration, Math.round(((2 - 1 / 64) / 3) * 1e6) / 1e6);
});

test('loop: the lanes are exactly as long as the stretch, or the freeze refuses', () => {
  const two = freeze([at(0, 1, { s: 1 })], { beats: 8, setup, loop: true });
  assert.equal(two.delta.cell1_patternLength, 8);
  assert.equal(two.delta.cell1_patternSpeed, 9);
  const long = freeze([at(0, 1, { s: 1 })], { beats: 64, setup, loop: true });
  assert.deepEqual([long.delta.cell1_patternSpeed, long.delta.cell1_patternLength], [8, 32]);
  assert.throws(() => freeze([at(0, 1, { s: 1 })], { beats: 2.5, setup, loop: true }), /2\.5 beats cannot loop in PAM/);
});

test('events at or past the end are left out, and a note that overhangs it is cut there', () => {
  const { delta } = freeze([at(3, 4, { s: 1 }), at(4, 1, { s: 1 }), at(9, 1, { s: 1 })], { beats: 4, setup });
  assert.equal(delta.cell1_midiSequence.length, 1);
  assert.equal(delta.cell1_midiSequence[0].duration, 0.984375);
});

test('pitched notes are written as the cell hears them, and a poly cell gets its own note at its root', () => {
  const { delta } = freeze([at(0, 1, { cell: 5, note: 'c2' }), at(1, 1, { cell: 5, n: 7 }), at(2, 1, { s: 5 })], { beats: 4, setup });
  assert.deepEqual(delta.cell5_midiSequence.map((n) => n.note), [36, 43, 36]);
  assert.deepEqual(delta.cells[5], { stepPropertyMode: 0, midiNote: 36 });
});

test('a changing cell knob becomes a pattern lane whose steps each last until the next', () => {
  const { delta, report } = freeze(
    [at(0, 4, { cell: 3, cell_filterCutoff: 300 }), at(4, 4, { cell: 3, cell_filterCutoff: 1200 }), at(8, 4, { cell: 3, cell_filterCutoff: 1200 }), at(12, 4, { cell: 3, cell_filterCutoff: 8000 })],
    { beats: 16, setup },
  );
  // 16 + 4 = 20 beats: speed 1, length 20. The repeat at beat 8 adds no step; the last runs to the clock's end.
  assert.deepEqual(delta.cell3_paramLane1Sequence, [
    { time: 0, value: 300, duration: 4 },
    { time: 4, value: 1200, duration: 8 },
    { time: 12, value: 8000, duration: 8 },
  ]);
  assert.equal(delta.cell3_patternLengthParam1, 20);
  assert.equal(delta.cell3_patternSpeedParam1, 9);
  assert.equal(delta.cells[3].paramLaneTarget1, 'filterCutoff');
  assert.equal(delta.cell3_midiSequence, undefined, 'a knob-only cell keeps its own notes');
  assert.deepEqual(report.cells[3].lanes, [{ lane: 1, target: 'filterCutoff', steps: 3 }]);
});

test('a knob set once at the top is a plain value, for cell and global parameters alike', () => {
  const { delta, report } = freeze([at(0, 1, { cell: 3, cell_delayMix: 40, macro_filterCutoff: 900, crossfade: -20 })], { beats: 8, setup });
  assert.equal(delta.cell3_delayMix, 40);
  assert.equal(delta.macro_filterCutoff, 900);
  assert.equal(delta.crossfade, -20);
  assert.equal(delta.cells, undefined);
  assert.deepEqual(report.static, ['cell3_delayMix', 'macro_filterCutoff', 'crossfade']);
  assert.deepEqual(report.unsupported, []);
});

test('a cell has four lanes: the fifth changing knob is reported, not dropped in silence', () => {
  const knobs = { filterCutoff: [300, 900], filterQ: [1, 2], delayMix: [10, 20], delayFeedback: [10, 20], pan: [-1, 1] };
  const timeline = Object.entries(knobs).flatMap(([k, [a, b]]) => [at(0, 4, { cell: 2, [`cell_${k}`]: a }), at(4, 4, { cell: 2, [`cell_${k}`]: b })]);
  const { delta, report } = freeze(timeline, { beats: 8, setup });
  assert.deepEqual([1, 2, 3, 4].map((k) => delta.cells[2][`paramLaneTarget${k}`]), ['filterCutoff', 'filterQ', 'delayMix', 'delayFeedback']);
  assert.deepEqual(report.unsupported, [{ what: 'cell2_pan', reason: 'cell 2 has no free pattern lane: PAM gives a cell 4' }]);
});

test('lanes the preset already uses are kept: the same target is reused, another lane is skipped', () => {
  const timeline = [at(0, 4, { cell: 2, cell_delayMix: 10, cell_pan: -1 }), at(4, 4, { cell: 2, cell_delayMix: 60, cell_pan: 1 })];
  const { delta } = freeze(timeline, { beats: 8, setup, lanes: { '2:1': 'filterCutoff', '2:2': 'delayMix' } });
  assert.equal(delta.cell2_paramLane1Sequence, undefined, 'lane 1 belongs to the preset');
  assert.equal(delta.cell2_paramLane2Sequence.length, 2, 'delayMix goes to the lane that already targets it');
  assert.equal(delta.cells[2].paramLaneTarget3, 'pan');
});

test('what PAM has no lane for is named: globals that move, parameters lanes may not lock', () => {
  const { report, delta } = freeze(
    [at(0, 4, { macro_filterCutoff: 300, cell: 1, cell_pitchShift: 0 }), at(4, 4, { macro_filterCutoff: 900, cell: 1, cell_pitchShift: 7 }), at(4, 4, { volume: -6 })],
    { beats: 8, setup },
  );
  assert.deepEqual(report.unsupported.map((u) => u.what).sort(), ['cell1_pitchShift', 'macro_filterCutoff', 'volume']);
  assert.match(report.unsupported.find((u) => u.what === 'macro_filterCutoff').reason, /only a cell's own parameters have pattern lanes/);
  assert.match(report.unsupported.find((u) => u.what === 'cell1_pitchShift').reason, /PAM allows no pattern lane on this parameter/);
  assert.match(report.unsupported.find((u) => u.what === 'volume').reason, /set once at beat 4/);
  assert.equal(delta.macro_filterCutoff, undefined);
});

test('mute is a lock of the cell fader at its bottom, closing 100 ms and opening 40 ms ahead', () => {
  const timeline = [at(0, 8, { cell: 3, cell_mute: 0 }), at(8, 4, { cell: 3, cell_mute: 1 }), at(12, 4, { cell: 3, cell_mute: 0 })];
  // At 120 BPM a beat is half a second: 0.2 and 0.08 beats.
  const { delta } = freeze(timeline, { beats: 16, setup, bpm: 120 });
  assert.equal(delta.cells[3].paramLaneTarget1, 'volume');
  assert.deepEqual(delta.cell3_paramLane1Sequence, [{ time: 7.8, value: -60, duration: 4.12 }]);
  // At 60 BPM the same times are half as many beats.
  assert.deepEqual(freeze(timeline, { beats: 16, setup, bpm: 60 }).delta.cell3_paramLane1Sequence, [{ time: 7.9, value: -60, duration: 4.06 }]);
});

test('a mute that lasts to the end holds through the guard bar, and one from the top starts at 0', () => {
  const { delta } = freeze([at(0, 4, { cell: 3, cell_mute: 1 }), at(4, 4, { cell: 3, cell_mute: 0 }), at(12, 4, { cell: 3, cell_mute: 1 })], { beats: 16, setup });
  assert.deepEqual(delta.cell3_paramLane1Sequence, [
    { time: 0, value: -60, duration: 3.92 },
    { time: 11.8, value: -60, duration: 8.2 },
  ]);
});

test('solo silences every other cell; a mute press toggles', () => {
  const solo = freeze([at(4, 4, { cell: 2, cell_solo: 1 }), at(8, 4, { cell: 2, cell_solo: 0 })], { beats: 12, setup });
  const locked = Object.keys(solo.delta.cells).map(Number);
  assert.deepEqual(locked, [1, 3, 4, 5, 6, 7, 8], 'every cell but the soloed one');
  assert.deepEqual(solo.delta.cell1_paramLane1Sequence, [{ time: 3.8, value: -60, duration: 4.12 }]);
  const press = freeze([at(2, 1, { cell: 4, press: 'mute' }), at(6, 1, { cell: 4, press: 'mute' })], { beats: 8, setup });
  assert.deepEqual(press.delta.cell4_paramLane1Sequence, [{ time: 1.8, value: -60, duration: 4.12 }]);
});

test('a muted cell whose fader is also patterned is reported: one lane cannot do both', () => {
  const { report } = freeze([at(0, 4, { cell: 3, cell_volume: -6, cell_mute: 1 }), at(4, 4, { cell: 3, cell_volume: 0, cell_mute: 0 })], { beats: 8, setup });
  assert.match(report.unsupported[0].what, /mute\/solo of cell 3/);
});

test('variation switches become PAM song steps that land on the next bar line', () => {
  const { song, slots, report } = freeze([at(0, 16, { variation: 2 }), at(16, 16, { variation: 3 }), at(34, 2, { variation: 2 })], { beats: 48, setup });
  assert.deepEqual(song.steps, [
    { startPositionBars: 0, endPositionBars: 4, variationIndex: 1, muted: false },
    { startPositionBars: 4, endPositionBars: 9, variationIndex: 2, muted: false, morphPhase: 'continue', morphTail: 'cut' },
    { startPositionBars: 9, endPositionBars: 12, variationIndex: 1, muted: false, morphPhase: 'continue', morphTail: 'cut' },
  ]);
  assert.deepEqual(song.stepNodeIds, ['n1', 'n2', 'n3']);
  assert.deepEqual(song.nodes.map((n) => [n.id, n.variationIndex, n.durationBars]), [['n1', 1, 4], ['n2', 2, 5], ['n3', 1, 3]]);
  assert.deepEqual(song.connections.map((c) => [c.fromId, c.toId, c.morphBars, c.transition.phase]), [['n1', 'n2', 0, 'continue'], ['n2', 'n3', 0, 'continue']]);
  assert.deepEqual(slots, [2, 3]);
  assert.deepEqual(report.song[1], { bars: [4, 9], variation: 3 });
});

test('before the first switch the song plays the variation it was told the preset opens on', () => {
  const { song, slots } = songFor([{ beat: 8, index: 3 }], { beats: 16, variation: 2 });
  assert.deepEqual(song.steps.map((s) => [s.startPositionBars, s.endPositionBars, s.variationIndex]), [[0, 2, 1], [2, 4, 2]]);
  assert.deepEqual(slots, [2, 3]);
  assert.deepEqual(songFor([], { beats: 16 }), { song: null, slots: [] });
  assert.deepEqual(songFor([{ beat: 0, index: 1 }, { beat: 4, index: 1 }], { beats: 8 }).song.steps.length, 1, 'repeats add no step');
});

test('live-only events are listed with why: actions, preset changes, plain controllers', () => {
  const { report } = freeze([at(0, 1, { press: 'record' }), at(1, 1, { progNum: 3 }), at(2, 1, { ccn: 74, ccv: 0.5 }), at(3, 1, { midicmd: 'clock' }), at(3, 1, { cell: 2, press: 'trigger' })], { beats: 4, setup });
  assert.deepEqual(report.unsupported.map((u) => u.what), ['press record', 'progNum', 'cc 74']);
  assert.equal(report.cells[2].notes, 1, 'a trigger press is a note of the cell');
});

test('freeze needs a length', () => {
  assert.throws(() => freeze([], {}), /needs the length in beats/);
});
