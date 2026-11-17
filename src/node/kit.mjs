/*
kit.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Builds a PAM preset from a kit: a short JSON file that says what differs from PAM's Init. The
// preset is what PAM loads, and the kit is what a person reads and edits. mapcli does every write.
//
//   {
//     "name": "Night Shift", "tempo": 132,
//     "programs": { "cmi": { "5": "acid_bass" }, "cmfx": { "5": "bbd_delay" } },   factory programs by id
//     "channels": "cell",              cell N listens on MIDI channel N
//     "pitched": [5, 7],               cells played by pitch: poly, rooted where note N sounds note N
//     "samples": { "3": "Drum Machines/Roland/Roland TR808/Hat_C02.wav" },   samples by path inside the library
//     "cells": { "5": { ... } },       cell config fields
//     "state": { "cell1_synthEngine": "Kick", "cell1_synth_p1": 0.4, ... },
//     "patterns": { "1": "x*4", "5": { "mini": "<c2 eb2>", "bars": 2 } },   PAM's own patterns, in mini-notation
//     "variations": { "2": { "state": { ... }, "cells": { ... }, "patterns": { ... } } }   other slots, as changes from slot 1
//   }
//
// A pattern is mini-notation for its cell (note names play pitches, x and ~ a rhythm, other numbers
// steps from the root), or { "mini", "bars", "as" }, or { "code": <Strudel>, "bars" }. "" clears the lane.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PAM_CELLS, PAM_DRUM_SYNTH_ENGINES, PAM_DRUM_SYNTH_NOTES, PAM_VARIATIONS, parseParamValue, resolveParam } from '../pam/params.mjs';
import { PAM_DEFAULT_ROOT, setupFromState } from '../pam/midimap.mjs';
import { patternToSequences } from './convert.mjs';
import { mapcli } from './mapcli.mjs';

// Enum values may be written by name: a parameter's own labels, or a drum-synth engine.
function resolveState(state = {}) {
  const out = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    if (/^cell\d+_synthEngine$/.test(key)) {
      const index = PAM_DRUM_SYNTH_ENGINES.findIndex((e) => e.toLowerCase() === value.toLowerCase());
      if (index < 0) throw new Error(`${key}: no drum-synth engine "${value}". There are: ${PAM_DRUM_SYNTH_ENGINES.join(', ')}`);
      out[key] = index;
      continue;
    }
    const param = resolveParam(key);
    const parsed = param?.labels ? parseParamValue(param, value) : undefined;
    out[key] = parsed ?? value;
  }
  return out;
}

// A kit's patterns as a state delta: each cell's mini-notation sampled into its note lane.
async function patternsDelta(patterns = {}, cellConfig) {
  const state = {};
  let cells = {};
  const setup = setupFromState({ cells: cellConfig });
  for (const [key, given] of Object.entries(patterns)) {
    const cell = Number(key);
    const spec = typeof given === 'string' ? { mini: given } : given;
    if (spec.mini === '' && spec.code === undefined) {
      state[`cell${cell}_midiSequence`] = [];
      continue;
    }
    const { delta, problems, report } = await patternToSequences({ ...spec, cell, bars: spec.bars ?? 1, setup });
    const wrong = [...problems, ...report.unsupported.map((u) => `${u.what}: ${u.reason}`)];
    if (wrong.length) throw new Error(`pattern for cell ${cell}: ${wrong.join('; ')}`);
    const { cells: patch, ...rest } = delta;
    Object.assign(state, rest);
    cells = mergeCells(cells, patch);
  }
  return { state, cells };
}

const mergeCells = (...patches) => {
  const out = {};
  for (const patch of patches) for (const [cell, fields] of Object.entries(patch ?? {})) out[cell] = { ...out[cell], ...fields };
  return out;
};

/**
 * Builds the preset a kit describes.
 *
 * @param {object} options
 * @param {string | object} options.kit path to the kit JSON, or the kit
 * @param {string} options.out path of the preset to write
 * @param {boolean} [options.force] replace `out` if it exists
 * @param {string} [options.library] the sample library that the kit's `samples` paths are inside.
 *   The preset keeps them relative to it, so it opens wherever that library is
 * @param {string} [options.mapcli]
 * @param {(message: string) => void} [options.log]
 * @param {typeof mapcli} [options.run] test seam: what runs mapcli
 * @returns {Promise<{ preset: string, roots: Record<string, number>, slots: number[] }>}
 */
export async function buildKit({ kit, out, force = false, library, mapcli: bin, log = () => {}, run: mapcliRun = mapcli }) {
  const spec = typeof kit === 'string' ? JSON.parse(readFileSync(kit, 'utf8')) : kit;
  const target = resolve(out);
  if (existsSync(target) && !force) throw new Error(`${target} exists. Pass --force to replace it`);
  const work = join(dirname(target), `.${basename(target)}.work`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const lib = library ? resolve(library) : undefined;
  const run = (args) => mapcliRun(args[0] === 'state' && lib ? [...args, '--library', lib] : args, { mapcli: bin, cwd: work });
  const samples = {};
  for (const [cell, path] of Object.entries(spec.samples ?? {})) {
    if (!lib) throw new Error('the kit names samples: pass --library <folder>, the library they are in');
    const file = join(lib, path);
    if (!existsSync(file)) throw new Error(`cell ${cell}: no sample at ${file}`);
    samples[cell] = { filePath: file };
  }
  const tempo = Number(spec.tempo ?? 120);

  try {
    // Factory CMI instruments and CM-FX cards can only be placed by id through `song make`: its
    // world file is Init plus the programs, which is the base that the kit's own changes go on.
    let base;
    if (spec.programs && Object.keys(spec.programs).length) {
      log('placing factory programs');
      writeFileSync(
        join(work, 'recipe.json'),
        JSON.stringify({ spec: 'song/1', tempo, world: [{ programs: spec.programs }], sections: { seed: 1, form: 'auto' } }),
      );
      await run(['song', 'make', 'recipe.json', '--save', 'programs.preset']);
      base = join(work, 'programs.world.preset');
    }

    // A pitched cell is poly with its root (and its own note: see freeze.mjs) where note N sounds N:
    // a CMI program's base note, read back from the preset, else its drum-synth engine's tuned
    // note, else PAM's default root.
    const roots = {};
    const pitched = spec.pitched ?? [];
    if (pitched.length) {
      const sources = base ? (await run(['preset', 'read', base])).slots?.[0]?.cells ?? [] : [];
      for (const cell of pitched) {
        const cmi = sources.find((c) => c.cell === cell)?.sources?.find((s) => s.kind === 'cmi');
        const engine = resolveState(spec.state)[`cell${cell}_synthEngine`];
        roots[cell] = spec.roots?.[cell] ?? cmi?.baseNote ?? PAM_DRUM_SYNTH_NOTES[engine] ?? PAM_DEFAULT_ROOT;
      }
    }
    const layout = {};
    for (let cell = 1; cell <= PAM_CELLS; cell++) {
      layout[cell] = {
        ...(spec.channels === 'cell' ? { midiChannel: cell } : typeof spec.channels === 'number' ? { midiChannel: spec.channels } : {}),
        ...(cell in roots ? { isPoly: 1, polyRootNote: roots[cell], midiNote: roots[cell] } : {}),
      };
    }

    // mapcli stores any key it is given, so a mistyped one would be saved and do nothing. So every
    // state key that the kit names has to be one that PAM's state already holds.
    const named = [...new Set([spec.state, ...Object.values(spec.variations ?? {}).map((v) => v.state)].flatMap((s) => Object.keys(s ?? {})))];
    if (named.length) {
      const { missingKeys = [] } = await run(['state', ...(base ? [base] : []), '--keys', named.join(',')]);
      if (missingKeys.length) throw new Error(`the kit names state keys PAM does not have: ${missingKeys.join(', ')}`);
    }

    const meta = { name: spec.name ?? basename(target).replace(/\.preset$/, ''), ...spec.meta };
    writeFileSync(join(work, 'meta.json'), JSON.stringify(meta));
    const cellConfig = mergeCells(layout, samples, spec.cells);
    const first = await patternsDelta(spec.patterns, cellConfig);
    writeFileSync(join(work, 'slot-1.json'), JSON.stringify([{ delta: { ...resolveState(spec.state), ...first.state, cells: mergeCells(cellConfig, first.cells) } }]));
    log('writing variation 1');
    await run(['state', ...(base ? [base] : []), '--tempo', String(tempo), '--envelopes', 'slot-1.json', '--save', 'kit-1.preset', '--meta', 'meta.json', '--keys', 'currentVariation']);

    // Each other slot starts from slot 1 and saves into its own. A last pass re-saves slot 1, so
    // the preset opens on it.
    let current = 'kit-1.preset';
    const slots = [1];
    for (const [slot, change] of Object.entries(spec.variations ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const k = Number(slot);
      if (!Number.isInteger(k) || k < 2 || k > PAM_VARIATIONS) throw new Error(`variations: "${slot}" is not a slot from 2 to ${PAM_VARIATIONS}`);
      log(`writing variation ${k}`);
      const own = await patternsDelta(change.patterns, mergeCells(cellConfig, change.cells));
      const cellsPatch = mergeCells(change.cells, own.cells);
      writeFileSync(join(work, `slot-${k}.json`), JSON.stringify([{ delta: { ...resolveState(change.state), ...own.state, ...(Object.keys(cellsPatch).length ? { cells: cellsPatch } : {}) } }]));
      const next = `kit-${k}.preset`;
      await run(['state', current, '--variation', '1', '--envelopes', `slot-${k}.json`, '--save', next, '--save-slot', String(k), '--meta', 'meta.json', '--keys', 'currentVariation']);
      current = next;
      slots.push(k);
    }
    if (slots.length > 1) {
      writeFileSync(join(work, 'none.json'), '[]');
      await run(['state', current, '--variation', '1', '--envelopes', 'none.json', '--save', 'kit-final.preset', '--save-slot', '1', '--meta', 'meta.json', '--keys', 'currentVariation']);
      current = 'kit-final.preset';
    }
    rmSync(target, { force: true });
    renameSync(join(work, current), target);
    return { preset: target, roots, slots };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
