/*
songs.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The Tidal songs against the Strudel songs they are ports of. No Haskell runs here, so this is
// not a test that they play: it checks each port against the patterns, the setup and the words of
// its original, which is where a port by hand goes wrong.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSetup } from '../../src/tidal/receiver.mjs';
import { TIDAL_WORDS, tidalParams } from '../../src/tidal/boot.mjs';
import { createSetup } from '../../src/pam/midimap.mjs';
import { evaluateStrudel } from '../../src/node/strudel.mjs';

const SONGS = ['techno/night-shift', 'trap/cold-rail', 'hiphop/haze-garden'];
// The hip hop port is the whole song, and its Strudel file is the loop at the song's fullest. So
// the port has every pattern of the loop, and besides them `added`: the one-kick opening and the
// ending. `rewritten` is what TidalCycles has no word for, and what the port writes in its place.
const ARRANGED = {
  'hiphop/haze-garden': {
    added: ['bd', 'vinylbrakeEngage', '[1,2,3,4,5,6,7,8]'],
    rewritten: { '<Dm9!2 Bb^7 Gm9>': '<[a3,d4,e4,f4,c5]!2 [bb2,d4,f4,a4] [g3,bb3,d4,f4,a4]>', 'd4:hirajoshi': null },
  },
};
const read = (song, ext) => readFileSync(new URL(`../../songs/${song}${ext}`, import.meta.url), 'utf8');
// The code with its comments taken out: line comments, and for Haskell the `{- ... -}` blocks too.
const code = (text, comment) =>
  (comment === '--' ? text.replace(/\{-[\s\S]*?-\}/g, '') : text)
    .split('\n')
    .map((line) => (line.includes(comment) ? line.slice(0, line.indexOf(comment)) : line))
    .join('\n');
const strings = (text) => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());

// Tidal's mini-notation as Strudel writes the same thing: note names an octave down with `b` for
// a flat, `t` and `f` as 1 and 0, and no zero before a decimal point.
const fromTidal = (text) =>
  text
    .replace(/\b([a-g])([sf#]?)(\d)\b/g, (_, letter, accidental, octave) => `${letter}${{ s: '#', f: 'b', '#': '#', '': '' }[accidental]}${octave - 1}`)
    .replace(/(^|[\s[<,])([tf])(?=[@\s\]>*!,]|$)/g, (_, before, bool) => `${before}${bool === 't' ? 1 : 0}`)
    .replace(/\b0\.(\d)/g, '.$1');
// Strudel writes a struct's hits as `x`, and may hold a rest for n steps where a port writes n rests.
const fromStrudel = (text) =>
  text.replace(/(^|[\s[<,])x(?=[@\s\]>*!,]|$)/g, '$11').replace(/~@(\d)/g, (_, n) => Array(Number(n)).fill('~').join(' '));

for (const song of SONGS) {
  test(`${song}.tidal has the patterns that ${song}.strudel.js has`, () => {
    const tidal = strings(code(read(song, '.tidal'), '--')).filter((s) => !s.includes('=')).map(fromTidal);
    const strudel = strings(code(read(song, '.strudel.js'), '//')).map(fromStrudel);
    assert.ok(tidal.length > 4);
    const arranged = ARRANGED[song];
    if (!arranged) return assert.deepEqual(tidal.sort(), strudel.sort());
    const expected = strudel.flatMap((s) => (s in arranged.rewritten ? [arranged.rewritten[s]].filter(Boolean) : [s]));
    assert.deepEqual([...new Set(tidal)].sort(), [...new Set([...expected, ...arranged.added])].sort());
  });

  test(`${song}.tidal describes the PAM that ${song}.strudel.js describes`, () => {
    const [, said] = /pamsetup "([^"]*)"/.exec(read(song, '.tidal'));
    const [, object] = /pamsetup\((\{[\s\S]*?\})\)/.exec(read(song, '.strudel.js'));
    const original = new Function(`return (${object})`)();
    assert.deepEqual(createSetup(parseSetup(said)), createSetup(original));
    assert.ok(Object.keys(original.names).length >= 8);
  });

  test(`${song}.tidal uses only words that mapaudio.tidal and TidalCycles have`, () => {
    const text = code(read(song, '.tidal'), '--').replace(/"[^"]*"/g, '""');
    // A name the song defines, with the names of its arguments when it is a function.
    const local = [...text.matchAll(/^\s+(?:let\s+)?([a-z]\w*(?:\s+[a-z]\w*)*)\s+=/gm)].flatMap((m) => m[1].split(/\s+/));
    const tidal = ['do', 'let', 'once', 'stack', 'mask', 'struct', 'ply', 'note', 'legato', 'velocity', 'range', 'saw', 'setcps', 'resetCycles', 'd1', 'd2', 'd3', 'd4', 'd5',
      'playFor', 'swingBy', 'sometimesBy', 'off', 'segment', 'toScale', 'perlin', 'gain'];
    const known = new Set([...TIDAL_WORDS, ...tidalParams().map((p) => p.word), ...tidal, ...local]);
    const used = [...new Set(text.match(/[A-Za-z_]\w*/g))];
    assert.deepEqual(used.filter((word) => !known.has(word)), []);
    // The same tempo, written Tidal's way: cycles a second.
    const [, bpm] = /setcps \((\d+)\/60\/4\)/.exec(text);
    assert.ok(read(song, '.strudel.js').includes(`setcpm(${bpm}/4)`));
  });
}

test('a setup block in {- -} is read as a comment, and each song has one after its tags', () => {
  assert.equal(code('d1 $ pam "bd" -- kick\n{-\nload "x.preset"\n-}\nd2 $ pam "hh"', '--').replace(/\s+/g, ' '), 'd1 $ pam "bd" d2 $ pam "hh"');
  for (const song of SONGS) {
    const text = read(song, '.tidal');
    const tags = text.split('\n').filter((line) => line.startsWith('-- @')).map((line) => line.split(' ')[1]);
    assert.deepEqual(tags, ['@title', '@by', '@genre', '@preset', '@cycles', '@license'], `${song}: the tags stay line comments`);
    const [, block] = /^\{-\n([\s\S]*?)\n-\}$/m.exec(text) ?? [];
    assert.ok(block, `${song}: a {- -} block`);
    assert.ok(text.indexOf('{-') > text.indexOf('-- @license') && text.indexOf('-}') < text.indexOf('once $ pamsetup "'), `${song}: the block sits between the tags and the code`);
    for (const said of [`${song.split('/')[1]}.preset`, `${song.split('/')[1]}.midimap.json`, 'mapuzu tidal', 'mapaudio.tidal', 'BootTidal.hs', 'once $ pamsetup']) {
      assert.ok(block.includes(said), `${song}: the setup block names ${said}`);
    }
  }
});

test('hiphop/haze-garden.tidal writes out the chords and the scale that Strudel works out', async () => {
  const names = async (pattern, cycles) => {
    const { pattern: p } = await evaluateStrudel(`$: ${pattern}`);
    return Array.from({ length: cycles }, (_, c) => p.queryArc(c, c + 1).filter((h) => h.hasOnset()).map((h) => String(h.value.note).toLowerCase()).sort());
  };
  const text = read('hiphop/haze-garden', '.tidal');
  // The guitar: Tidal has no voicing(), so the port names each chord's notes.
  const [, chords] = /note "(<\[[^"]*)" # pam "gtr"/.exec(text);
  assert.deepEqual(await names(`note("${fromTidal(chords)}")`, 4), await names('chord("<Dm9!2 Bb^7 Gm9>").voicing()', 4));
  // The koto: the port gives the scale as semitones above Tidal's note 0, which is Strudel's c4.
  const [, degrees] = /toScale \[([\d, ]+)\]/.exec(text);
  const chromatic = ['c', 'c#', 'd', 'eb', 'e', 'f', 'f#', 'g', 'ab', 'a', 'bb', 'b'];
  const [scale] = await names('n("0 1 2 3 4").scale("d4:hirajoshi")', 1);
  assert.deepEqual(degrees.split(',').map((d) => `${chromatic[Number(d)]}4`).sort(), scale);
});

test('the octave shift is the one the receiver applies: Tidal\'s c5 and Strudel\'s c4 are both middle C', () => {
  assert.equal(fromTidal('c5 ef3 f4 [af3,bf2] cs6'), 'c4 eb2 f3 [ab2,bb1] c#5');
  assert.equal(fromTidal('<t@8 f@16> t*4 [~ t] 0.5 10.5 0@4'), '<1@8 0@16> 1*4 [~ 1] .5 10.5 0@4');
  assert.equal(fromStrudel('x ~ [~ x] x*4'), '1 ~ [~ 1] 1*4');
});
