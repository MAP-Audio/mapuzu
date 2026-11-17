/*
params.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  PAM_CELLS,
  resolveParam,
  listParams,
  parseParamValue,
  toNormalized,
  fromNormalized,
  toMidi7,
  fromMidi7,
} from '../../src/pam/params.mjs';
import table from '../../src/pam/params.generated.mjs';
import { buildTable } from '../../scripts/gen-pam-params.mjs';

test('a per-cell name resolves with its cell, by full id, by cell_<name> and bare', () => {
  const full = resolveParam('cell3_filterCutoff');
  assert.equal(full.id, 'cell3_filterCutoff');
  assert.equal(full.scope, 'cell');
  assert.equal(full.cell, 3);
  assert.deepEqual([full.min, full.max, full.skew, full.unit], [20, 20000, 0.25, 'Hz']);
  assert.equal(resolveParam('cell_filterCutoff', 3).id, 'cell3_filterCutoff');
  assert.equal(resolveParam('filterCutoff', 3).id, 'cell3_filterCutoff');
});

test('a per-cell name without a cell, a cell out of range and an unknown name resolve to nothing', () => {
  assert.equal(resolveParam('filterCutoff'), undefined);
  assert.equal(resolveParam('cell_filterCutoff'), undefined);
  assert.equal(resolveParam('cell9_filterCutoff'), undefined);
  assert.equal(resolveParam('cell0_filterCutoff'), undefined);
  assert.equal(resolveParam('filterCutoff', 9), undefined);
  assert.equal(resolveParam('cell3_filterCutof'), undefined);
  assert.equal(resolveParam(''), undefined);
  assert.equal(resolveParam(undefined), undefined);
});

test('volume is the cell fader on a cell and the master without one, and other globals ignore the cell', () => {
  assert.equal(resolveParam('volume').id, 'volume');
  assert.equal(resolveParam('volume').scope, 'global');
  assert.equal(resolveParam('volume', 4).id, 'cell4_volume');
  assert.equal(resolveParam('cell_volume', 4).id, 'cell4_volume');
  assert.equal(resolveParam('crossfade', 4).id, 'crossfade');
  assert.equal(resolveParam('macro_filterCutoff', 4).id, 'macro_filterCutoff');
});

test('hosted plug-in parameters resolve by shape, 0..1, inside the cell and slot counts', () => {
  const p = resolveParam('hosted_p2_17');
  assert.deepEqual([p.scope, p.cell, p.n, p.min, p.max], ['hosted', 2, 17, 0, 1]);
  assert.equal(resolveParam('hosted_p9_0'), undefined);
  assert.equal(resolveParam('hosted_p1_384'), undefined);
});

test('listParams gives every cell the same names, and no id twice', () => {
  const all = listParams();
  const ids = new Set(all.map((p) => p.id));
  assert.equal(ids.size, all.length);
  const perCell = (c) => all.filter((p) => p.cell === c).map((p) => p.suffix);
  for (let c = 2; c <= PAM_CELLS; c++) assert.deepEqual(perCell(c), perCell(1));
  assert.ok(perCell(1).length > 400, 'the manifest has several hundred per-cell parameters');
  assert.deepEqual(
    listParams({ cells: [2], match: (id) => id.endsWith('_delayMix') }).map((p) => p.id),
    ['macro_delayMix', 'cell2_delayMix'],
  );
});

test('normalized position is the proportion raised to the skew, and back', () => {
  const cutoff = resolveParam('cell1_filterCutoff'); // 20..20000 Hz, skew 0.25
  assert.equal(toNormalized(cutoff, 20), 0);
  assert.equal(toNormalized(cutoff, 20000), 1);
  // (1000 - 20) / 19980 = 0.049049..., ** 0.25 = 0.47061...
  assert.ok(Math.abs(toNormalized(cutoff, 1000) - 0.47061) < 1e-4);
  assert.equal(fromNormalized(cutoff, 0.5), 1269); // 20 + 19980 * 0.5 ** 4 = 1268.75, step 1
  const volume = resolveParam('cell1_volume'); // -60..12 dB, skew 3.8
  // 0 dB: (60 / 72) ** 3.8 = 0.50018...
  assert.ok(Math.abs(toNormalized(volume, 0) - 0.50018) < 1e-4);
  const pan = resolveParam('cell1_pan'); // -1..1, linear
  assert.equal(toNormalized(pan, 0), 0.5);
  assert.equal(toNormalized(pan, 5), 1, 'out of range clamps');
});

test('toMidi7 gives the value that a 0..127 absolute mapping needs, and fromMidi7 is what PAM then holds', () => {
  const cutoff = resolveParam('cell1_filterCutoff');
  assert.equal(toMidi7(cutoff, 20), 0);
  assert.equal(toMidi7(cutoff, 20000), 127);
  assert.equal(toMidi7(cutoff, 1000), 60); // 0.47061 * 127 = 59.77
  assert.equal(fromMidi7(cutoff, 60), 1015); // 20 + 19980 * (60/127) ** 4 = 1015.33
  const mode = resolveParam('cell1_mode'); // 0 Trigger, 1 Gate, 2 Loop
  assert.deepEqual([0, 1, 2].map((v) => toMidi7(mode, v)), [0, 64, 127]);
  assert.deepEqual([0, 64, 127].map((v) => fromMidi7(mode, v)), [0, 1, 2]);
});

test('seven bits cannot reach every value: the round trip of a 1 Hz step parameter is lossy', () => {
  const cutoff = resolveParam('cell1_filterCutoff');
  assert.equal(fromMidi7(cutoff, toMidi7(cutoff, 1000)), 1015);
  // The skew crowds the bottom: 20 + 19980 * (5/127) ** 4 = 20.05 Hz, so MIDI 0..5 are all 20 Hz,
  // and the top step alone is 127 -> 126: 20000 - (20 + 19980 * (126/127) ** 4) = 622 Hz.
  assert.equal(fromMidi7(cutoff, 5), 20);
  assert.equal(fromMidi7(cutoff, 127) - fromMidi7(cutoff, 126), 622);
});

test('selectors put slot 1 at MIDI 0 and the last slot at 127, as PAM reads them', () => {
  const variation = resolveParam('variationSelect'); // 0 Off, 1..8
  assert.equal(variation.selector, true);
  assert.deepEqual([1, 2, 8].map((v) => toMidi7(variation, v)), [0, 18, 127]);
  assert.deepEqual([0, 18, 127].map((v) => fromMidi7(variation, v)), [1, 2, 8]);
  const pattern = resolveParam('cell2_patternSelect'); // 1..128 map one to one
  for (let slot = 1; slot <= 128; slot++) assert.equal(fromMidi7(pattern, toMidi7(pattern, slot)), slot);
});

test('values parse from numbers, numeric strings, booleans and enum labels', () => {
  const mode = resolveParam('cell1_mode');
  assert.equal(parseParamValue(mode, 2), 2);
  assert.equal(parseParamValue(mode, '2'), 2);
  assert.equal(parseParamValue(mode, 'Gate'), 1);
  assert.equal(parseParamValue(mode, 'loop'), 2);
  assert.equal(parseParamValue(mode, 'nope'), undefined);
  assert.equal(parseParamValue(mode, NaN), undefined);
  assert.equal(parseParamValue(mode, {}), undefined);
  const speed = resolveParam('cell1_patternSpeed');
  assert.equal(parseParamValue(speed, '1/32'), 0, 'a label that is not a number reads as a label');
  assert.equal(parseParamValue(speed, '1.5'), 1.5, 'a label that is also a number reads as the number');
});

const manifestOf = (...ids) => ({
  name: 'PAM',
  parameterVersion: 1,
  parameters: ids.map((paramId) => ({ paramId, min: 0, max: 1, step: 0.01, defaultValue: 0, isModulatable: true })),
});

test('the generator never gives a number twice: a new parameter takes the one after the highest ever given', () => {
  const first = buildTable(manifestOf('a', 'b', 'c', 'cell1_x', 'cell1_y'));
  assert.deepEqual([first.global.a.n, first.global.b.n, first.global.c.n], [0, 1, 2]);
  assert.deepEqual([first.cell.x.n, first.cell.y.n], [0, 1]);
  assert.deepEqual(first.nextNumber, { cell: 2, global: 3 });
  // b leaves the middle, c and x leave the ends, d and z arrive: 1, 2 and 0 stay unused
  const second = buildTable(manifestOf('d', 'a', 'cell1_z', 'cell1_y'), first);
  assert.deepEqual([second.global.a.n, second.global.d.n], [0, 3]);
  assert.deepEqual([second.cell.y.n, second.cell.z.n], [1, 2]);
  assert.deepEqual(second.nextNumber, { cell: 3, global: 4 });
  // d leaves too, and the table no longer holds a 3: the mark remembers it
  const third = buildTable(manifestOf('a', 'e'), second);
  assert.equal(third.global.e.n, 4);
  assert.deepEqual(third.nextNumber, { cell: 3, global: 5 });
  // a table written before the mark was kept starts after its highest number
  const { nextNumber, ...unmarked } = first;
  assert.equal(buildTable(manifestOf('a', 'b', 'c', 'f'), unmarked).global.f.n, 3);
});

test('the table holds each number once, and its mark is above them all', () => {
  for (const scope of ['cell', 'global']) {
    const numbers = Object.values(table[scope]).map((e) => e.n);
    assert.equal(new Set(numbers).size, numbers.length);
    assert.ok(table.nextNumber[scope] > Math.max(...numbers));
  }
});
