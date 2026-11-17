/*
boot.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// mapaudio.tidal: that the file in the repo is the one the generator writes, that it has a word
// for every parameter and no two alike, and that what its words send is what the receiver reads.
// No Haskell runs here: these check the file against PAM's parameter table and the receiver.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootFile, bootLines, tidalParams, tidalWord, TIDAL_BOOT, TIDAL_WORDS, TIDAL_LATENCY, TIDAL_PORT } from '../../src/tidal/boot.mjs';
import { tidalValue, KNOB_PREFIX, TIDAL_ADDRESS, TIDAL_MARK } from '../../src/tidal/receiver.mjs';
import { compileValue } from '../../src/pam/events.mjs';
import { cellParamNames, listParams, resolveParam } from '../../src/pam/params.mjs';

const committed = readFileSync(new URL('../../mapaudio.tidal', import.meta.url), 'utf8');

test('mapaudio.tidal in the repo is what `mapuzu tidal --boot` writes', () => {
  assert.equal(committed, bootFile(), 'run: node bin/mapuzu.mjs tidal --boot --out mapaudio.tidal');
});

test('the BootTidal.hs lines for Tidal 1.9 and 1.10 are the same in the boot script, the README and what is printed', () => {
  assert.deepEqual(TIDAL_BOOT.map((b) => b.tidal), ['1.10', '1.9']);
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const printed = bootLines('/somewhere/mapaudio.tidal', '   ');
  for (const { tidal, replaces, stream } of TIDAL_BOOT) {
    assert.match(stream, /pamOscMap/, 'each version gives the stream PAM\'s target');
    // The line it stands in for assigns the same name, or the rest of BootTidal.hs would not find the stream.
    assert.equal(stream.split(' <- ')[0], replaces.split(' <- ')[0], `Tidal ${tidal}`);
    for (const [where, text] of [['mapaudio.tidal', committed], ['README.md', readme], ['mapuzu tidal', printed]]) {
      assert.ok(text.includes(stream), `${where} has the Tidal ${tidal} line`);
      assert.ok(text.includes(replaces.replace(' ...', '')), `${where} says which line Tidal ${tidal}'s replaces`);
    }
  }
  assert.ok(printed.includes('   Tidal 1.10, in place of the line that says  tidalInst <- mkTidal\n\n     :script /somewhere/mapaudio.tidal\n     tidalInst <- mkTidalWith'));
});

test('every mappable parameter has one word, and no word is defined twice', () => {
  const params = tidalParams();
  const ids = new Set(params.map((p) => p.id));
  for (const name of cellParamNames()) assert.ok(ids.has(name), name);
  for (const param of listParams({ cells: [] })) assert.ok(ids.has(param.id), param.id);
  assert.equal(ids.size, params.length);

  const words = [...TIDAL_WORDS, ...params.map((p) => p.word)];
  assert.equal(new Set(words).size, words.length);
  // Each word is defined once in the file, as a Haskell name can be.
  for (const { word, id, labels } of params) {
    assert.match(word, /^pam[A-Z][A-Za-z0-9_]*$/);
    const defined = committed.split('\n').filter((line) => line.trim().startsWith(`${word} `));
    assert.deepEqual(defined.map((line) => line.trim().replace(/\s+/g, ' ')), [`${word} = ${labels ? 'knobS' : 'knob'} "${id}"`]);
  }
  assert.equal(tidalWord('filterCutoff'), 'pamFilterCutoff');
});

test('a parameter that takes names gets the word that takes names', () => {
  const byId = new Map(tidalParams().map((p) => [p.id, p]));
  assert.equal(byId.get('mode').labels, true);
  assert.equal(byId.get('filterCutoff').labels, false);
  for (const { id, labels } of tidalParams()) {
    const param = resolveParam(id, 1) ?? resolveParam(id);
    assert.equal(labels, Boolean(param.labels), id);
  }
});

test('what every word sends, the receiver reads as that parameter', () => {
  for (const { id } of tidalParams()) {
    const param = resolveParam(id, 3) ?? resolveParam(id);
    // The middle of the range: a value no parameter clamps or reads as Off.
    const sent = param.selector ? 1 : (param.min + param.max) / 2;
    const read = tidalValue([TIDAL_MARK, 1, 'cell', '3', `${KNOB_PREFIX}${id}`, sent]);
    assert.deepEqual(read.problems, [], id);
    const { events, problems } = compileValue(read.value, {});
    assert.deepEqual(problems, [], id);
    const knobs = events.filter((e) => e.type === 'knob');
    assert.equal(knobs.length, 1, id);
    assert.ok(knobs[0].param.id === id || knobs[0].param.id === `cell3_${id}`, `${id} arrived as ${knobs[0].param.id}`);
  }
});

test('the file and the receiver agree: its address, its mark, its port and a latency past the variation lead', () => {
  assert.ok(committed.includes(`OSC "${TIDAL_ADDRESS}" $ Named {requiredArgs = ["${TIDAL_MARK}"]}`));
  assert.ok(committed.includes(`oPort      = ${TIDAL_PORT},`));
  assert.ok(committed.includes(`oLatency   = ${TIDAL_LATENCY},`));
  assert.ok(TIDAL_LATENCY > 0.2 + 0.05, 'a variation switch goes out 200 ms ahead, and Tidal sends in frames of 50 ms');
  assert.ok(committed.includes('oSchedule  = Pre BundleStamp'), 'the receiver takes its timing from the bundle');
  // Every hand-written word is defined, and every one of them marks its events for PAM.
  for (const word of TIDAL_WORDS) assert.match(committed, new RegExp(`^(let )?\\s*${word}\\b.* =`, 'm'), word);
  const said = committed.split('\n').filter((line) => !line.startsWith('--') && /\bp[SFI] [("]/.test(line));
  assert.equal(said.length, 10, 'pamto, pam, cell, knob, knobS, variation, pampress, pamsetup, pamclockOf, pamstop');
  for (const line of said) assert.ok(line.endsWith('# pamto') || line.startsWith('let pamto'), line);
});

test('the blocks open and close, and nothing in the file is a tab or trails a space', () => {
  const lines = committed.split('\n');
  let open = false;
  for (const line of lines) {
    if (line === ':{') {
      assert.equal(open, false);
      open = true;
    } else if (line === ':}') {
      assert.equal(open, true);
      open = false;
    }
    assert.ok(!line.includes('\t') && line === line.trimEnd(), JSON.stringify(line));
  }
  assert.equal(open, false);
});
