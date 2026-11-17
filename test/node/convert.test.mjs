/*
convert.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { miniKind, patternToSequences, sequencesToStrudel, presetToStrudel, PAM_SPEED_FACTORS } from '../../src/node/convert.mjs';
import { collect, evaluateStrudel } from '../../src/node/strudel.mjs';
import { readPreset, variationStates } from '../../src/node/preset.mjs';
import { createSetup, setupFromState } from '../../src/pam/midimap.mjs';

const song = (path) => fileURLToPath(new URL(`../../songs/${path}`, import.meta.url));

test('miniKind: names are notes, x and 1/0 a rhythm, other numbers steps, and operator numbers do not count', () => {
  const kinds = {
    'x*8': 'hit',
    '~ x': 'hit',
    '1 0 1 1': 'hit',
    'x(3,8)': 'hit',
    '[x x]!2 ~@3': 'hit',
    'c2 [eb2 g2]': 'note',
    '<c2 eb2>*4': 'note',
    'bb2@3 ~': 'note',
    'a b c': 'note',
    '0 3 7': 'n',
    '0 .. 7': 'n',
    '<0 2>*8': 'n',
  };
  for (const [mini, kind] of Object.entries(kinds)) assert.equal(miniKind(mini), kind, mini);
  assert.throws(() => miniKind('bd sd'), /cannot tell what "bd sd" plays/);
});

test('a rhythm becomes hits of the cell note, looping exactly on its bars', async () => {
  const { delta, report, code } = await patternToSequences({ mini: 'x ~ ~ x ~ ~ x ~', cell: 2, bars: 1 });
  assert.equal(code, 's("2").struct("x ~ ~ x ~ ~ x ~")');
  assert.deepEqual(delta.cell2_midiSequence, [
    { time: 0, duration: 0.484375, note: 49, velocity: 114 },
    { time: 1.5, duration: 0.484375, note: 49, velocity: 114 },
    { time: 3, duration: 0.484375, note: 49, velocity: 114 },
  ]);
  assert.equal(delta.cell2_patternLength, 4);
  assert.equal(delta.cell2_patternSpeed, 9);
  assert.equal(report.cells[2].notes, 3);
});

test('note names become pitches over as many bars as asked; numbers count from the root', async () => {
  const setup = createSetup({ poly: [5], roots: { 5: 36 } });
  const notes = await patternToSequences({ mini: '<c2 [eb2 g2]>', cell: 5, bars: 2, setup });
  assert.deepEqual(notes.delta.cell5_midiSequence.map((n) => [n.time, n.note]), [[0, 36], [4, 39], [6, 43]]);
  assert.equal(notes.delta.cell5_patternLength, 8);
  const steps = await patternToSequences({ mini: '0 3 7 12', cell: 5, bars: 1, setup });
  assert.deepEqual(steps.delta.cell5_midiSequence.map((n) => n.note), [36, 39, 43, 48]);
});

test('sixteen bars loop at half speed, since a PAM pattern holds 32 beats', async () => {
  const { delta } = await patternToSequences({ mini: '<x ~>', cell: 1, bars: 16 });
  assert.deepEqual([delta.cell1_patternSpeed, delta.cell1_patternLength], [8, 32]);
  assert.deepEqual(delta.cell1_midiSequence.map((n) => n.time), [0, 4, 8, 12, 16, 20, 24, 28]);
});

test('Strudel code converts every cell it names, --as overrides the reading, and missing pieces are refused', async () => {
  const both = await patternToSequences({ code: 'stack(s("1*2"), note("c3").cell(3))', bars: 1 });
  assert.deepEqual(Object.keys(both.delta).filter((k) => k.endsWith('midiSequence')), ['cell1_midiSequence', 'cell3_midiSequence']);
  const forced = await patternToSequences({ mini: '1 0 1 1', cell: 5, as: 'n', bars: 1, setup: createSetup({ poly: [5] }) });
  assert.deepEqual(forced.delta.cell5_midiSequence.map((n) => n.note), [49, 48, 49, 49]);
  await assert.rejects(patternToSequences({ mini: 'x', bars: 1 }), /which cell/);
  await assert.rejects(patternToSequences({ mini: 'x', cell: 1 }), /how many bars/);
});

test('a drum lane reads back as one token per beat, with the fewest steps that hold its hits', () => {
  const state = {
    cell1_patternLength: 4,
    cell1_midiSequence: [0, 1, 2, 3].map((time) => ({ time, duration: 0.2, note: 48, velocity: 114 })),
    cell3_patternLength: 4,
    cell3_midiSequence: [0, 0.5, 1.75, 2, 2.333333, 2.666667].map((time, i) => ({ time, duration: 0.1, note: 50, velocity: i % 2 ? 64 : 102 })),
  };
  const { code, cells } = sequencesToStrudel(state);
  assert.deepEqual(code.split('\n'), [
    '// cell 1: 4 notes over 4 beats',
    '$: s("1").struct("x!4").pam()',
    '// cell 3: 6 notes over 4 beats',
    '$: s("3").struct("[x x] [~ ~ ~ x] [x x x] ~").velocity("[0.8 0.5] [~ ~ ~ 0.8] [0.5 0.8 0.5] ~").pam()',
  ]);
  assert.equal(cells[1].grid, 12, 'eighths, a sixteenth and a triplet share a grid of twelve to the beat');
});

test('a mono cell only plays its own note: other notes in its lane are counted and left out', () => {
  const { code, cells } = sequencesToStrudel({ cell2_patternLength: 4, cell2_midiSequence: [{ time: 0, duration: 1, note: 49, velocity: 114 }, { time: 1, duration: 1, note: 60, velocity: 114 }] });
  assert.match(code, /struct\("x ~!3"\)/);
  assert.equal(cells[0].ignored, 1);
});

test('a melodic lane reads back with held lengths, rests and chords, one bar per step of <>', () => {
  const state = {
    cells: { 5: { isPoly: 1, polyRootNote: 36, midiNote: 36 } },
    cell5_patternLength: 8,
    cell5_midiSequence: [
      { time: 0, duration: 2 - 1 / 64, note: 36, velocity: 114 },
      { time: 3, duration: 1 - 1 / 64, note: 39, velocity: 114 },
      { time: 4, duration: 4 - 1 / 64, note: 36, velocity: 114 },
      { time: 4, duration: 4 - 1 / 64, note: 43, velocity: 114 },
    ],
  };
  const { code } = sequencesToStrudel(state);
  assert.equal(code.split('\n')[1], '$: note("<[c2@2 ~ eb2] [c2,g2]>").cell(5).pam()');
});

test('notes struck together at different velocities are voices of their own, not one chord at the first velocity', () => {
  const together = (velocities) => ({
    cells: { 5: { isPoly: 1, polyRootNote: 36, midiNote: 36 } },
    cell5_patternLength: 4,
    cell5_midiSequence: velocities.map((velocity, i) => ({ time: 0, duration: 4 - 1 / 64, note: 60 + 4 * i, velocity })),
  });
  assert.deepEqual(sequencesToStrudel(together([32, 32])).code.split('\n').slice(1), ['$: note("[c4,e4]").cell(5).velocity(0.25).pam()']);
  assert.deepEqual(sequencesToStrudel(together([32, 127])).code.split('\n').slice(1), [
    '$: note("c4").cell(5).velocity("0.25").pam()',
    '$: note("e4").cell(5).velocity("1").pam()',
  ]);
});

test('a pattern of rests for one cell empties that cell\'s lane, so what was there stops playing', async () => {
  const { delta } = await patternToSequences({ mini: '~', cell: 2, bars: 1 });
  assert.deepEqual(delta, { cell2_midiSequence: [] });
  const played = await patternToSequences({ mini: 'x ~', cell: 2, bars: 1 });
  assert.equal(played.delta.cell2_midiSequence.length, 1);
});

test('pattern speed and odd lengths become slow() and fast(), as exact ratios', async () => {
  const hit = (time) => ({ time, duration: 0.1, note: 48, velocity: 114 });
  const half = sequencesToStrudel({ cell1_patternLength: 4, cell1_patternSpeed: 8, cell1_midiSequence: [hit(0), hit(2)] });
  assert.match(half.code, /struct\("x ~ x ~"\)\.slow\(2\)\.pam\(\)/);
  const three = sequencesToStrudel({ cell1_patternLength: 3, cell1_midiSequence: [hit(0), hit(1), hit(2)] });
  assert.match(three.code, /struct\("x!3"\)\.fast\(4\/3\)\.pam\(\)/);
  // Written as 1.33 the lane would come round every 3.0075 beats and drift off the other cells.
  const { pattern } = await evaluateStrudel(three.code);
  const beats = collect(pattern, { cycles: 30, setup: createSetup() }).timeline.map((entry) => entry.beat);
  assert.deepEqual(beats, Array.from({ length: 120 }, (_, beat) => beat));
  const triplets = sequencesToStrudel({ cell1_patternLength: 4, cell1_patternSpeed: PAM_SPEED_FACTORS.indexOf(5 / 3), cell1_midiSequence: [hit(0)] });
  assert.match(triplets.code, /\.fast\(5\/3\)\.pam\(\)/);
});

// Every variation of every song preset, read back as Strudel and frozen again, plays the notes the
// preset holds: same onsets, pitches and velocities over four bars.
for (const path of ['techno/night-shift.preset', 'trap/cold-rail.preset', 'hiphop/haze-garden.preset']) {
  test(`round trip: ${path} -> Strudel -> the same notes`, async () => {
    const { state } = readPreset(song(path));
    const slots = variationStates(state);
    const all = slots.size ? [...slots] : [[1, state]];
    let compared = 0;
    for (const [slot, slotState] of all) {
      const { code } = presetToStrudel(song(path), { variation: slots.size ? slot : undefined });
      const { pattern } = await evaluateStrudel(code);
      const { timeline, problems } = collect(pattern, { cycles: 4, setup: setupFromState(slotState) });
      assert.deepEqual(problems, []);
      const got = new Map();
      for (const entry of timeline) {
        for (const e of entry.events) {
          if (e.type !== 'note') continue;
          const list = got.get(e.cell) ?? got.set(e.cell, []).get(e.cell);
          list.push(`${Math.round(entry.beat * 1000) / 1000}:${e.note ?? 'own'}:${Math.round(e.velocity * 127)}`);
        }
      }
      for (let cell = 1; cell <= 8; cell++) {
        const lane = slotState[`cell${cell}_midiSequence`] ?? [];
        const length = slotState[`cell${cell}_patternLength`];
        const poly = slotState.cells[cell].isPoly > 0;
        const expected = [];
        for (let from = 0; from < 16; from += length) {
          for (const n of lane) expected.push(`${Math.round((from + n.time) * 1000) / 1000}:${poly ? n.note : 'own'}:${n.velocity}`);
        }
        assert.deepEqual((got.get(cell) ?? []).sort(), expected.sort(), `${path} variation ${slot} cell ${cell}`);
        compared += expected.length;
      }
    }
    // Only the trap preset holds note lanes: the techno one is sounds alone, and the hip hop one's tabla is a player.
    if (path === 'trap/cold-rail.preset') assert.ok(compared > 100, 'the preset with patterns was compared note by note');
    else assert.equal(compared, 0);
  });
}

test('presetToStrudel writes the tempo and the pamsetup() the preset needs', () => {
  const { code, bpm, variation } = presetToStrudel(song('trap/cold-rail.preset'), { variation: 3, cells: [4] });
  assert.equal(bpm, 140);
  assert.equal(variation, 3);
  assert.deepEqual(code.split('\n').slice(0, 3), [
    '// @title Cold Rail (variation 3)',
    'setcpm(140/4)',
    "await pamsetup({ channels: 'cell', poly: [5, 7, 8], roots: { 5: 36, 7: 60, 8: 48 } })",
  ]);
  // The hook's open hat is on the last eighth of beats two and four.
  assert.match(code, /\$: s\("4"\)\.struct\("~ \[~ x\] ~ \[~ x\]"\)\.pam\(\)/);
  assert.throws(() => presetToStrudel(song('trap/cold-rail.preset'), { variation: 8 }), /variation 8 of .* is empty/);
});
