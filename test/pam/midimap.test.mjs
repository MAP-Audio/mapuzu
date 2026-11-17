/*
midimap.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PAM_CELLS, listParams, resolveParam } from '../../src/pam/params.mjs';
import {
  PAM_ACTIONS,
  createSetup,
  setupFromState,
  paramNumber,
  parseAction,
  actionTarget,
  mappingRows,
} from '../../src/pam/midimap.mjs';

test('a setup with no options is PAM as installed: channel 1, notes 48-55, no poly cells', () => {
  const setup = createSetup();
  assert.equal(setup.cells.length, 8);
  assert.deepEqual(setup.cells[0], { channel: 1, note: 48, root: 48, poly: false });
  assert.deepEqual(setup.cells[7], { channel: 1, note: 55, root: 48, poly: false });
  assert.equal(setup.control, 16);
  assert.deepEqual(setup.listeners.variation, { channel: 1, cc: 16 });
  assert.deepEqual(setup.listeners.looper, { channel: 0, cc: 17 });
  assert.deepEqual(setup.listeners.preset, { channel: 1 });
  assert.deepEqual(setup.cc, {});
});

test('cells are named by number and cN by default, and names add to those', () => {
  const setup = createSetup({ names: { bd: 1, hh: 3 } });
  assert.equal(setup.names['3'], 3);
  assert.equal(setup.names.c8, 8);
  assert.equal(setup.names.bd, 1);
  assert.equal(setup.names.hh, 3);
  assert.throws(() => createSetup({ names: { bd: 9 } }), /name "bd" points at cell 9/);
});

test("channels: 'cell' puts cell N on channel N, and a number, a list and a map all work", () => {
  assert.deepEqual(createSetup({ channels: 'cell' }).cells.map((c) => c.channel), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(createSetup({ channels: 10 }).cells.map((c) => c.channel), Array(8).fill(10));
  assert.deepEqual(createSetup({ channels: [1, 1, 1, 1, 5] }).cells.map((c) => c.channel), [1, 1, 1, 1, 5, 1, 1, 1]);
  assert.deepEqual(createSetup({ channels: { 8: 9 } }).cells.map((c) => c.channel), [1, 1, 1, 1, 1, 1, 1, 9]);
  assert.throws(() => createSetup({ channels: 17 }), /channel for cell 1 is 17/);
  assert.throws(() => createSetup({ notes: [128] }), /note for cell 1 is 128/);
});

test('poly takes cell numbers or one flag per cell', () => {
  assert.deepEqual(createSetup({ poly: [5, 8] }).cells.map((c) => c.poly), [false, false, false, false, true, false, false, true]);
  assert.deepEqual(createSetup({ poly: [true, false] }).cells.map((c) => c.poly).slice(0, 2), [true, false]);
  assert.throws(() => createSetup({ poly: [9] }), /poly names cell 9/);
});

test('cc sends a parameter as a plain CC: automap is PAM\'s CC 1-8 macros on channel 1', () => {
  const auto = createSetup({ cc: 'automap' });
  assert.deepEqual(auto.cc.macro_filterCutoff, { cc: 6, channel: 1 });
  assert.deepEqual(auto.cc.macro_samplerVolume, { cc: 1, channel: 1 });
  const own = createSetup({ cc: { cell1_volume: { cc: 21, channel: 2 }, crossfade: 8 } });
  assert.deepEqual(own.cc, { cell1_volume: { cc: 21, channel: 2 }, crossfade: { cc: 8, channel: 1 } });
  assert.throws(() => createSetup({ cc: { filterCutoff: 74 } }), /not a full PAM parameter id/);
});

test('setupFromState reads what the preset saved, and a slice-keymap cell counts as poly', () => {
  const cells = {};
  for (let c = 1; c <= 8; c++) cells[c] = { midiChannel: c, midiNote: 47 + c, polyRootNote: 48, isPoly: 0, sliceKeymapMode: 0 };
  cells[5].isPoly = 1;
  cells[5].polyRootNote = 36;
  cells[6].sliceKeymapMode = 1;
  const setup = setupFromState({ cells }, { names: { bass: 5 } });
  assert.deepEqual(setup.cells[4], { channel: 5, note: 52, root: 36, poly: true });
  assert.deepEqual(setup.cells[5], { channel: 6, note: 53, root: 48, poly: true });
  assert.equal(setup.cells[0].poly, false);
  assert.equal(setup.names.bass, 5);
  assert.deepEqual(setupFromState({}).cells, createSetup().cells, 'a state with no cells is PAM as installed');
});

test('every parameter and action has its own NRPN number, inside 14 bits', () => {
  const seen = new Map();
  const claim = (number, what) => {
    assert.ok(Number.isInteger(number) && number >= 0 && number <= 16383, `${what}: ${number}`);
    assert.equal(seen.get(number), undefined, `${what} shares ${number} with ${seen.get(number)}`);
    seen.set(number, what);
  };
  for (const p of listParams({ hosted: true })) claim(paramNumber(p), p.id);
  for (const [name, def] of Object.entries(PAM_ACTIONS)) {
    if (!def.action) continue;
    if (!def.cell) claim(actionTarget(name).number, name);
    else for (let c = 1; c <= PAM_CELLS; c++) claim(actionTarget(name, c).number, `${name}:${c}`);
  }
  assert.ok(seen.size > 7000);
});

test('numbers are laid out in blocks: globals below 1024, cell c from c * 1024', () => {
  assert.ok(paramNumber(resolveParam('volume')) < 1024);
  const c1 = paramNumber(resolveParam('cell1_filterCutoff'));
  const c8 = paramNumber(resolveParam('cell8_filterCutoff'));
  assert.equal(Math.floor(c1 / 1024), 1);
  assert.equal(c8 - c1, 7 * 1024);
  assert.equal(paramNumber(resolveParam('hosted_p1_0')), 9216);
  assert.equal(paramNumber(resolveParam('hosted_p2_3')), 9216 + 384 + 3);
});

test('actions: cell ones need a cell, listener ones have no mapping target, track ones take 1-8', () => {
  assert.deepEqual(actionTarget('mute', 3), { paramId: '__action_cellToggleMute3', number: 12288 + 2 * 8 + 2 });
  assert.deepEqual(actionTarget('trigger', 1), { paramId: '__action_cellTrigger1', number: 12288 });
  assert.equal(actionTarget('mute'), undefined);
  assert.equal(actionTarget('record').paramId, '__action_midiRecordToggle');
  assert.equal(actionTarget('looperRecord'), undefined);
  assert.equal(parseAction('mute').name, 'mute');
  assert.equal(parseAction('looperMute:3').arg, 3);
  assert.equal(parseAction(['looperMute', 3]).arg, 3);
  assert.equal(parseAction('looperMute'), undefined, 'a track action needs its track');
  assert.equal(parseAction('looperMute:9'), undefined);
  assert.equal(parseAction('mute:3'), undefined, 'a cell action takes its cell from the hap');
  assert.equal(parseAction('nope'), undefined);
});

test('mappingRows writes rows PAM imports: NRPN, absolute, full window, any channel by default', () => {
  const rows = mappingRows({ params: ['cell3_filterCutoff', 'volume'], actions: ['mute:3', 'record'] });
  assert.deepEqual(
    rows.map((r) => r.paramId),
    ['volume', 'cell3_filterCutoff', '__action_cellToggleMute3', '__action_midiRecordToggle'],
  );
  const cutoff = rows[1];
  assert.deepEqual(cutoff, {
    id: `mapuzu-${paramNumber(resolveParam('cell3_filterCutoff'))}`,
    paramId: 'cell3_filterCutoff',
    source: 'nrpn',
    channel: 0,
    number: paramNumber(resolveParam('cell3_filterCutoff')),
    mode: 'absolute',
    range: { min: 0, max: 127 },
    invert: false,
    enabled: true,
  });
  assert.equal(mappingRows({ params: ['volume'], actions: [], channel: 16 })[0].channel, 16);
  assert.throws(() => mappingRows({ params: ['filterCutoff'] }), /not a full PAM parameter id/);
  assert.throws(() => mappingRows({ params: [], actions: ['looperRecord'] }), /not an action mapuzu's map carries/);
});

test('the full map has one row per parameter and mapped action, and repeats the same', () => {
  const all = mappingRows();
  assert.equal(all.length, listParams().length + 4 * 8 + 1);
  assert.equal(new Set(all.map((r) => r.number)).size, all.length);
  assert.deepEqual(mappingRows(), all);
  assert.deepEqual(mappingRows({ params: ['volume', 'volume'], actions: [] }).length, 1);
});
