/*
render.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// A Strudel song and its PAM preset -> a WAV (and MP3), offline. The song is evaluated here, its
// `.pam()` haps are frozen into PAM's own sequencer state, and mapcli renders the result:
// mapcli takes no MIDI, so freezing is the only way in.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { freeze } from '../pam/freeze.mjs';
import { setupFromState } from '../pam/midimap.mjs';
import { PAM_CELLS } from '../pam/params.mjs';
import { collect, evaluateStrudel, loadStrudel } from './strudel.mjs';
import { currentSlot, laneTargets, readPreset, variationStates } from './preset.mjs';
import { mapcli } from './mapcli.mjs';

/** `// @key value` lines of a Strudel file's header, as Jack's patterns carry them. */
export function songTags(code) {
  const tags = {};
  for (const line of code.split('\n')) {
    const m = /^\s*\/\/\s*@(\w+)\s+(.*?)\s*$/.exec(line);
    if (m && !(m[1] in tags)) tags[m[1]] = m[2];
  }
  return tags;
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Evaluates a song against its preset and freezes it. No engine runs and nothing is written.
 *
 * @param {object} options
 * @param {string} options.song path to the `.strudel.js` file
 * @param {string} [options.preset] path to the preset. The default is the song's `// @preset` tag, beside the song
 * @param {number} [options.cycles] length in cycles. The default is the song's `// @cycles` tag
 * @param {number} [options.beatsPerCycle] default 4
 */
export async function freezeSong({ song, preset, cycles, beatsPerCycle = 4 }) {
  const songPath = resolve(song);
  const code = readFileSync(songPath, 'utf8');
  const tags = songTags(code);
  const presetPath = resolve(preset ?? join(dirname(songPath), tags.preset ?? `${basename(songPath).replace(/\.strudel\.js$|\.js$/, '')}.preset`));
  if (!existsSync(presetPath)) {
    // Only a song that has a kit beside it can be told to build its preset.
    const kit = songPath.replace(/\.strudel\.js$|\.js$/, '.kit.json');
    const build = existsSync(kit) ? `build it with "mapuzu kit ${basename(kit)} --out ${basename(presetPath)}", ` : '';
    throw new Error(`no preset at ${presetPath}: ${build}pass --preset, or name it in a "// @preset" line`);
  }
  const length = Number(cycles ?? tags.cycles);
  if (!(length > 0)) throw new Error('how long is the song? Pass --cycles, or add a "// @cycles N" line');

  const { output } = await loadStrudel();
  output.reset();
  const { pattern, cps } = await evaluateStrudel(code);
  const declared = output.pamstatus();
  const { state } = readPreset(presetPath);
  // Notes and roots come from the preset, which is what PAM will do, and names come from the song.
  const setup = setupFromState(state, { names: declared.options.names });
  const mismatches = Object.keys(declared.options).some((k) => ['channels', 'notes', 'roots', 'poly'].includes(k))
    ? setupMismatches(declared.setup, setup)
    : [];

  const { timeline, problems, haps } = collect(pattern, { cycles: length, beatsPerCycle, setup });
  if (!haps) throw new Error('the song sends nothing to .pam(): nothing to freeze');
  const beats = length * beatsPerCycle;
  const bpm = cps * 60 * beatsPerCycle;
  const frozen = freeze(timeline, { beats, setup, beatsPerBar: beatsPerCycle, bpm, variation: currentSlot(state), lanes: laneTargets(state) });
  return {
    songPath,
    presetPath,
    tags,
    cycles: length,
    beats,
    bpm,
    seconds: length / cps,
    haps,
    problems: [...problems, ...mismatches],
    filledSlots: [...variationStates(state).keys()],
    timeline,
    ...frozen,
  };
}

// Where the song's pamsetup() and the preset disagree: live, those notes would go astray.
function setupMismatches(declared, actual) {
  const out = [];
  declared.cells.forEach((cell, i) => {
    const real = actual.cells[i];
    for (const key of ['channel', 'note', 'root', 'poly']) {
      const relevant = key === 'root' ? cell.poly || real.poly : key === 'note' ? !cell.poly && !real.poly : true;
      if (relevant && cell[key] !== real[key]) out.push(`cell ${i + 1}: pamsetup says ${key} ${cell[key]}, the preset says ${real[key]}`);
    }
  });
  return out;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} failed: ${stderr.trim().split('\n').at(-1)}`))));
  });
}

/** WAV -> MP3 beside it, with ffmpeg (or lame when there is no ffmpeg). */
export async function encodeMp3(wav, mp3 = wav.replace(/\.wav$/i, '.mp3')) {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '2', mp3]);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await run('lame', ['--quiet', '-V', '2', wav, mp3]);
  }
  return mp3;
}

/**
 * Renders a song to WAV and MP3.
 *
 * @param {object} options `freezeSong`'s, and:
 * @param {string} options.outDir folder for the WAV, the MP3, the frozen preset and the render record
 * @param {number} [options.tail] seconds of effect tail after the last cycle (default: the song's `// @tail`, else 2)
 * @param {number} [options.seed] render seed (default 1, so the same song renders the same file)
 * @param {number} [options.sampleRate] default 48000
 * @param {boolean} [options.mp3] default true
 * @param {boolean} [options.stems] also write one WAV per cell
 * @param {boolean} [options.force] replace a previous render of this song in `outDir`
 * @param {boolean} [options.allowMissing] render samples that cannot be found as silence
 * @param {string} [options.library] PAM library folder, where the preset's samples are looked up
 * @param {string} [options.mapcli] path to mapcli
 * @param {(message: string) => void} [options.log]
 * @param {typeof mapcli} [options.run] test seam: what runs mapcli
 */
export async function renderSong(options) {
  const { outDir, seed = 1, sampleRate = 48000, mp3 = true, stems = false, force = false, allowMissing = false, library, log = () => {}, run: mapcliRun = mapcli } = options;
  if (!outDir) throw new Error('where should the render go? Pass --out <folder>');
  const frozen = await freezeSong(options);
  const name = basename(frozen.songPath).replace(/\.strudel\.js$|\.js$/, '');
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const paths = {
    wav: join(dir, `${name}.wav`),
    mp3: join(dir, `${name}.mp3`),
    preset: join(dir, `${name}.frozen.preset`),
    record: join(dir, `${name}.render.json`),
    work: join(dir, `.${name}.work`),
  };
  const stemPaths = Array.from({ length: PAM_CELLS }, (_, i) => join(dir, `${name}-cell${i + 1}.wav`));
  const taken = [paths.wav, paths.mp3, paths.preset, ...stemPaths].filter(existsSync);
  if (taken.length && !force) throw new Error(`already rendered: ${taken.join(', ')}. Pass --force to replace`);
  // Only this song's own outputs, by the names built above.
  for (const path of [...taken, paths.record]) rmSync(path, { force: true });
  rmSync(paths.work, { recursive: true, force: true });
  mkdirSync(paths.work);

  const tail = Number(options.tail ?? frozen.tags.tail ?? 2);
  const run1 = { mapcli: options.mapcli };
  const common = [...(library ? ['--library', library] : []), ...(allowMissing ? ['--allow-missing'] : [])];
  const renderArgs = ['--seed', String(seed), '--sample-rate', String(sampleRate), '--tail', String(tail), ...(stems ? ['--stems'] : []), ...common];
  const envelopes = join(paths.work, 'frozen.json');
  writeFileSync(envelopes, JSON.stringify([{ delta: frozen.delta }]));
  const tempo = String(Math.round(frozen.bpm * 1000) / 1000);
  const progress = (f) => log(`render ${Math.round(f * 100)}%`);

  let render;
  if (!frozen.song) {
    // One pass: the frozen lanes over the preset as it opens, rendered and saved together.
    log(`freezing ${frozen.haps} events into ${basename(frozen.presetPath)} and rendering ${frozen.seconds.toFixed(1)} s`);
    const result = await mapcliRun(
      ['state', frozen.presetPath, '--tempo', tempo, '--envelopes', envelopes, '--render', '--seconds', String(frozen.seconds), '--out', paths.wav, '--save', paths.preset, ...renderArgs],
      { ...run1, onProgress: progress },
    );
    render = result.render;
  } else {
    // The song switches variations: every slot that it plays needs the frozen lanes, and then PAM's
    // own song plays the slots. The slot that the preset opens on goes last, so that the preset opens
    // there again.
    const missing = frozen.slots.filter((s) => !frozen.filledSlots.includes(s));
    if (missing.length) throw new Error(`the song switches to variation ${missing.join(', ')}, which the preset does not have`);
    const first = frozen.slots[0];
    const order = [...frozen.filledSlots.filter((s) => s !== first), first];
    let current = frozen.presetPath;
    const songFile = join(paths.work, 'song.json');
    writeFileSync(songFile, JSON.stringify([{ delta: frozen.delta }, { delta: { songMode: frozen.song } }]));
    for (const [i, slot] of order.entries()) {
      const last = i === order.length - 1;
      const next = last ? paths.preset : join(paths.work, `slot-${slot}.preset`);
      log(`freezing into variation ${slot}`);
      await mapcliRun(
        ['state', current, '--variation', String(slot), '--tempo', tempo, '--envelopes', last ? songFile : envelopes, '--save', next, '--save-slot', String(slot), '--keys', 'currentVariation', ...(library ? ['--library', library] : [])],
        run1,
      );
      current = next;
    }
    log(`rendering the song: ${frozen.song.steps.length} steps, ${frozen.seconds.toFixed(1)} s`);
    render = await mapcliRun(['preset', 'render', paths.preset, '--song', '--out', paths.wav, ...renderArgs], { ...run1, onProgress: progress });
  }
  rmSync(paths.work, { recursive: true, force: true });

  if (mp3) {
    log('encoding MP3');
    await encodeMp3(paths.wav, paths.mp3);
  }
  const record = {
    song: frozen.songPath,
    songSha256: sha256(frozen.songPath),
    preset: frozen.presetPath,
    presetSha256: sha256(frozen.presetPath),
    title: frozen.tags.title,
    bpm: frozen.bpm,
    cycles: frozen.cycles,
    seconds: frozen.seconds,
    tail,
    seed,
    sampleRate,
    wav: paths.wav,
    mp3: mp3 ? paths.mp3 : null,
    frozenPreset: paths.preset,
    events: frozen.haps,
    problems: frozen.problems,
    report: frozen.report,
    render: { durationSeconds: render?.durationSeconds, latencySamples: render?.latencySamples, missingSamples: render?.missingSamples, stems: render?.stems },
  };
  writeFileSync(paths.record, JSON.stringify(record, null, 1) + '\n');
  return record;
}
