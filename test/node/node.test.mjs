/*
node.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The offline side without mapcli: Strudel evaluated here, presets read from the songs folder,
// and the render and kit pipelines run against a stand-in that records what mapcli was asked.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { collect, evaluateStrudel } from '../../src/node/strudel.mjs';
import { currentSlot, decodeVariation, laneTargets, readPreset, variationStates } from '../../src/node/preset.mjs';
import { mapcli, MapcliError } from '../../src/node/mapcli.mjs';
import { freezeSong, renderSong, songTags } from '../../src/node/render.mjs';
import { buildKit } from '../../src/node/kit.mjs';
import { createSetup } from '../../src/pam/midimap.mjs';

const song = (path) => fileURLToPath(new URL(`../../songs/${path}`, import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), 'mapuzu-test-'));

test('REPL code evaluates as in the REPL: labels, mini-notation strings, setcpm', async () => {
  const { pattern, cps } = await evaluateStrudel(`
    setcpm(140/4)
    $: s("1*4").pam()
    bass: note("c2 eb2").cell(5).pam()
    _$: s("2*8").pam()
  `);
  assert.ok(Math.abs(cps - 140 / 4 / 60) < 1e-12);
  const haps = pattern.queryArc(0, 1).filter((h) => h.hasOnset());
  assert.equal(haps.length, 6, 'four hits and two notes, and the muted label plays nothing');
});

test('a tempo that is never set is the REPL default, and broken code throws its own error', async () => {
  assert.equal((await evaluateStrudel('s("1").pam()')).cps, 0.5);
  await assert.rejects(evaluateStrudel('s("1").nope()'), /nope is not a function/);
  await assert.rejects(evaluateStrudel('knob("filterCutof", 1).pam()'), /PAM has no parameter "filterCutof"/);
});

test('collect reads only what was sent to .pam(), in beats, and gathers problems once', async () => {
  const { pattern } = await evaluateStrudel(`
    $: s("1 2").pam()
    $: s("bd*4")
    $: note("c2").pam()
    $: note("d2").pam()
  `);
  const { timeline, problems, haps } = collect(pattern, { cycles: 2 });
  assert.equal(haps, 8, 'two cycles of two hits and two cell-less notes, and the superdough pattern is not counted');
  assert.deepEqual(timeline.map((e) => [e.beat, e.beats, e.events[0].cell]), [[0, 2, 1], [2, 2, 2], [4, 2, 1], [6, 2, 2]]);
  assert.deepEqual(problems, ['a note needs a cell: add .cell(n) or s(name)']);
  assert.equal(collect(pattern, { cycles: 1, all: true }).timeline.length, 2, 'all: true also reads the others, which name no cell');
  assert.throws(() => collect(pattern, {}), /needs the number of cycles/);
});

test('collect takes names from the setup and starts counting at `begin`', async () => {
  const { pattern } = await evaluateStrudel('$: s("<bd sd>").pam()');
  const setup = createSetup({ names: { bd: 1, sd: 2 } });
  assert.deepEqual(collect(pattern, { cycles: 2, begin: 1, setup }).timeline.map((e) => [e.beat, e.events[0].cell]), [[0, 2], [4, 1]]);
});

test('a preset reads as metadata and state, and its variations decode from PAMZ1', () => {
  const { meta, state } = readPreset(song('trap/cold-rail.preset'));
  assert.equal(meta.name, 'Cold Rail');
  assert.equal(meta.bpm, 140);
  assert.equal(state.cells[5].isPoly, 1);
  assert.equal(currentSlot(state), 1);
  const slots = variationStates(state);
  assert.deepEqual([...slots.keys()], [1, 2, 3, 4]);
  assert.equal(slots.get(1).cell3_midiSequence.length, 8, 'variation 1 has plain eighth-note hats');
  assert.equal(slots.get(4).cell3_midiSequence.length, 0, 'the break has no hats');
});

test('no song needs a sample: no cell of any preset names a file, in any variation', () => {
  for (const path of ['techno/night-shift.preset', 'trap/cold-rail.preset', 'hiphop/haze-garden.preset']) {
    const { state } = readPreset(song(path));
    const all = [state, ...variationStates(state).values()];
    assert.ok(all.length > 1, path);
    for (const s of all) {
      assert.deepEqual(Object.keys(s.cells), ['1', '2', '3', '4', '5', '6', '7', '8'], path);
      for (const [cell, config] of Object.entries(s.cells)) assert.equal(config.filePath, '', `${path} cell ${cell}`);
    }
  }
});

test('variation entries: PAMZ1, plain JSON from old presets, and empty slots', () => {
  const slot = { cell1_volume: -6 };
  const packed = `PAMZ1:${deflateSync(Buffer.from(JSON.stringify(slot))).toString('base64')}`;
  assert.deepEqual(decodeVariation(packed), slot);
  assert.deepEqual(decodeVariation(JSON.stringify(slot)), slot);
  assert.equal(decodeVariation(''), undefined);
  assert.equal(decodeVariation(null), undefined);
});

test('readPreset also takes a bare state document and the published { meta, state } form', () => {
  assert.deepEqual(readPreset(Buffer.from('{"cell1_volume":-3}')), { meta: {}, state: { cell1_volume: -3 } });
  assert.deepEqual(readPreset(Buffer.from('{"meta":{"bpm":90},"state":{"volume":0}}')), { meta: { bpm: 90 }, state: { volume: 0 } });
});

test('laneTargets lists the pattern-lane targets that a state already uses', () => {
  assert.deepEqual(laneTargets({ cells: { 2: { paramLaneTarget1: 'filterCutoff', paramLaneTarget2: '' }, 5: { paramLaneTarget3: 'delayMix' } } }), { '2:1': 'filterCutoff', '5:3': 'delayMix' });
  assert.deepEqual(laneTargets({}), {});
});

// A child process that prints what a mapcli run would.
function fakeSpawn({ stdout = '', stderr = '', exitCode = 0, error }) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (error) return child.emit('error', error);
      if (stderr) child.stderr.emit('data', stderr);
      if (stdout) child.stdout.emit('data', stdout);
      child.emit('close', exitCode);
    });
    return child;
  };
  return { spawn, calls };
}

test('mapcli runs with --json, returns the result and reports render progress', async () => {
  const fake = fakeSpawn({ stdout: '{"ok":true,"render":{"durationSeconds":2}}\n', stderr: '{"progress":0.5}\n{"progress":1}\n' });
  const progress = [];
  const result = await mapcli(['state', 'a.preset'], { mapcli: '/opt/mapcli', cwd: '/work', spawn: fake.spawn, onProgress: (f) => progress.push(f) });
  assert.deepEqual(result, { ok: true, render: { durationSeconds: 2 } });
  assert.deepEqual(fake.calls[0].args, ['state', 'a.preset', '--json']);
  assert.equal(fake.calls[0].command, '/opt/mapcli');
  assert.equal(fake.calls[0].options.cwd, '/work');
  assert.deepEqual(progress, [0.5, 1]);
});

test('mapcli failures carry the code and the reason: refused, unlicensed, not installed', async () => {
  const refused = fakeSpawn({ stdout: '{"ok":false,"code":"missing_samples","error":"missing samples: [\\"a.wav\\"]"}\n', exitCode: 1 });
  await assert.rejects(mapcli(['preset', 'render', 'x'], { spawn: refused.spawn }), (err) => {
    assert.ok(err instanceof MapcliError);
    assert.equal(err.code, 'missing_samples');
    assert.match(err.message, /mapcli preset render failed: missing samples/);
    return true;
  });
  const locked = fakeSpawn({ stdout: '{"ok":false,"code":"license_required","error":"licence required"}\n', exitCode: 3 });
  await assert.rejects(mapcli(['state'], { spawn: locked.spawn }), /needs a PAM licence or trial on this machine/);
  const missing = fakeSpawn({ error: Object.assign(new Error('spawn mapcli ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(mapcli(['version'], { spawn: missing.spawn }), /was not found\. Pass --mapcli, or set MAPCLI/);
});

test('songTags reads the header lines, first one wins', () => {
  assert.deepEqual(songTags('// @title Night Shift\n// @cycles 88\n//@tail 4\nsetcpm(132/4)\n// @cycles 2\n'), { title: 'Night Shift', cycles: '88', tail: '4' });
});

test('freezeSong: the techno song is all Strudel notes, with its knobs in pattern lanes', async () => {
  const frozen = await freezeSong({ song: song('techno/night-shift.strudel.js') });
  assert.equal(frozen.cycles, 88);
  assert.equal(frozen.bpm, 132);
  assert.equal(frozen.seconds, 160);
  assert.equal(frozen.song, null);
  assert.deepEqual(frozen.problems, []);
  assert.deepEqual(frozen.report.unsupported, []);
  assert.deepEqual(Object.keys(frozen.report.cells).map(Number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(frozen.report.cells[5].lanes.map((l) => l.target), ['cmi_p1', 'cmi_p3', 'delayMix']);
  // 88 bars + the guard bar = 356 beats: speed 1/12, 30 pattern beats.
  assert.deepEqual(frozen.report.clock, { speed: 2, slow: 12, length: 30 });
  assert.equal(frozen.delta.cell1_midiSequence.length, 334);
});

const noteLanes = (delta) => Object.keys(delta).filter((k) => k.endsWith('midiSequence')).map((k) => Number(k[4]));
const laneTargetsOf = (delta) => Object.fromEntries(Object.entries(delta.cells).filter(([, c]) => c.paramLaneTarget1).map(([cell, c]) => [cell, c.paramLaneTarget1]));

test('freezeSong: the trap song is both at once: a song of eight steps, with PAM\'s own patterns left alone', async () => {
  const frozen = await freezeSong({ song: song('trap/cold-rail.strudel.js') });
  assert.deepEqual(frozen.report.song.map((s) => s.variation), [4, 1, 2, 3, 4, 2, 3, 4]);
  assert.deepEqual(frozen.report.song.at(-2).bars, [56, 72]);
  assert.deepEqual(frozen.slots, [1, 2, 3, 4]);
  assert.deepEqual(frozen.filledSlots, [1, 2, 3, 4]);
  assert.deepEqual(noteLanes(frozen.delta), [1, 2, 5, 7, 8], 'no note is written over PAM\'s hats, open hat and rim');
  assert.deepEqual(laneTargetsOf(frozen.delta), { 3: 'volume', 5: 'synth_p4', 6: 'volume', 7: 'delayMix' }, 'the two mutes are fader lanes, and each knob has a lane');
  assert.deepEqual(frozen.problems, []);
});

test('freezeSong: the hip hop song plays beside a player of PAM\'s own, which is left alone', async () => {
  const frozen = await freezeSong({ song: song('hiphop/haze-garden.strudel.js') });
  assert.deepEqual(frozen.report.song, [{ bars: [0, 16], variation: 3 }], 'one variation, held for the sixteen bars');
  assert.deepEqual(frozen.filledSlots, [1, 2, 3]);
  assert.deepEqual(noteLanes(frozen.delta), [1, 2, 3, 5, 6, 7, 8], 'every cell that Strudel plays, and not the tabla');
  assert.equal(frozen.delta.cell1_midiSequence.length, 48, 'three kicks a bar');
  assert.equal(frozen.delta.cell2_midiSequence.length, 32, 'a snare on two and four');
  assert.deepEqual(frozen.report.cells[4], { notes: 0, lanes: [{ lane: 1, target: 'playerDensity', steps: 64 }] }, 'the tabla gets no notes, only four density values a bar');
  assert.deepEqual(laneTargetsOf(frozen.delta), { 4: 'playerDensity' });
  assert.deepEqual(frozen.problems, []);
  assert.deepEqual(frozen.report.unsupported, []);
});

test('freezeSong says where pamsetup() and the preset disagree, and what it cannot find', async () => {
  const dir = scratch();
  try {
    const file = join(dir, 'wrong.strudel.js');
    writeFileSync(file, `// @cycles 1\npamsetup({ channels: 'cell', poly: [5], roots: { 5: 48 } })\n$: note("c2").cell(5).pam()\n`);
    const frozen = await freezeSong({ song: file, preset: song('techno/night-shift.preset') });
    assert.deepEqual(frozen.problems, ['cell 5: pamsetup says root 48, the preset says 36', 'cell 7: pamsetup says poly false, the preset says true', 'cell 8: pamsetup says poly false, the preset says true']);
    assert.equal(frozen.delta.cell5_midiSequence[0].note, 36, 'notes are frozen as the preset will hear them');
    await assert.rejects(freezeSong({ song: file }), /no preset at .*wrong\.preset: pass --preset, or name it/);
    writeFileSync(join(dir, 'wrong.kit.json'), '{}');
    await assert.rejects(freezeSong({ song: file }), /no preset at .*wrong\.preset: build it with "mapuzu kit wrong\.kit\.json --out wrong\.preset", pass --preset/);
    writeFileSync(file, `$: s("1").pam()\n`);
    await assert.rejects(freezeSong({ song: file, preset: song('techno/night-shift.preset') }), /how long is the song\? Pass --cycles/);
    writeFileSync(file, `// @cycles 1\n$: s("bd")\n`);
    await assert.rejects(freezeSong({ song: file, preset: song('techno/night-shift.preset') }), /sends nothing to \.pam\(\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Stands in for mapcli: records each call, and writes the files a real run would.
function fakeMapcli() {
  const calls = [];
  const run = async (args, options = {}) => {
    const files = {};
    const envelopes = args[args.indexOf('--envelopes') + 1];
    if (args.includes('--envelopes')) files.envelopes = JSON.parse(readFileSync(options.cwd ? join(options.cwd, envelopes) : envelopes, 'utf8'));
    calls.push({ args, files, cwd: options.cwd });
    for (const flag of ['--save', '--out']) {
      if (!args.includes(flag)) continue;
      const path = args[args.indexOf(flag) + 1];
      writeFileSync(options.cwd ? join(options.cwd, path) : path, flag);
    }
    if (args[0] === 'song') writeFileSync(join(options.cwd, 'programs.world.preset'), 'world');
    if (args[0] === 'preset' && args[1] === 'read') return { slots: [{ cells: [{ cell: 5, sources: [{ kind: 'cmi', baseNote: 36 }] }] }] };
    if (args[0] === 'state' && args.includes('--keys') && !args.includes('--save')) {
      return { ok: true, missingKeys: args[args.indexOf('--keys') + 1].split(',').filter((k) => k.includes('Typo')) };
    }
    return { ok: true, render: { durationSeconds: 1, latencySamples: 52, missingSamples: [] } };
  };
  return { run, calls };
}

test('renderSong without variations is one mapcli pass: freeze, render and save together', async () => {
  const dir = scratch();
  try {
    const fake = fakeMapcli();
    const record = await renderSong({ song: song('techno/night-shift.strudel.js'), outDir: dir, mp3: false, run: fake.run });
    assert.equal(fake.calls.length, 1);
    const { args, files } = fake.calls[0];
    assert.deepEqual(args.slice(0, 2), ['state', song('techno/night-shift.preset')]);
    assert.equal(args[args.indexOf('--tempo') + 1], '132');
    assert.equal(args[args.indexOf('--seconds') + 1], '160');
    assert.equal(args[args.indexOf('--tail') + 1], '4', 'the tail comes from the song header');
    assert.equal(args[args.indexOf('--seed') + 1], '1');
    assert.equal(args[args.indexOf('--out') + 1], join(dir, 'night-shift.wav'));
    assert.equal(args[args.indexOf('--save') + 1], join(dir, 'night-shift.frozen.preset'));
    assert.ok(args.includes('--render'));
    assert.equal(files.envelopes.length, 1);
    assert.equal(files.envelopes[0].delta.cell1_midiSequence.length, 334);
    assert.equal(record.wav, join(dir, 'night-shift.wav'));
    assert.equal(record.mp3, null);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'night-shift.render.json'), 'utf8')).report.unsupported, []);
    assert.equal(existsSync(join(dir, '.night-shift.work')), false, 'the work folder is cleared');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderSong with variations freezes into every slot, the opening one last, then renders the song', async () => {
  const dir = scratch();
  try {
    const fake = fakeMapcli();
    await renderSong({ song: song('trap/cold-rail.strudel.js'), outDir: dir, mp3: false, stems: true, library: '/lib', run: fake.run });
    const slotOf = (c) => c.args[c.args.indexOf('--save-slot') + 1];
    assert.deepEqual(fake.calls.map((c) => c.args[0]), ['state', 'state', 'state', 'state', 'preset']);
    assert.deepEqual(fake.calls.slice(0, 4).map(slotOf), ['2', '3', '4', '1']);
    assert.deepEqual(fake.calls.slice(0, 4).map((c) => c.args[c.args.indexOf('--variation') + 1]), ['2', '3', '4', '1']);
    assert.equal(fake.calls[1].args[1], join(dir, '.cold-rail.work', 'slot-2.preset'), 'each pass starts from the one before');
    assert.equal(fake.calls[3].files.envelopes.length, 2, 'the last pass also sets the song');
    assert.equal(fake.calls[3].files.envelopes[1].delta.songMode.steps.length, 8);
    assert.equal(fake.calls[0].files.envelopes.length, 1);
    const render = fake.calls[4].args;
    assert.deepEqual(render.slice(0, 4), ['preset', 'render', join(dir, 'cold-rail.frozen.preset'), '--song']);
    assert.ok(render.includes('--stems'));
    assert.equal(render[render.indexOf('--library') + 1], '/lib');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderSong keeps an earlier render unless told to replace it, and refuses a missing variation', async () => {
  const dir = scratch();
  try {
    const fake = fakeMapcli();
    const options = { song: song('techno/night-shift.strudel.js'), outDir: dir, mp3: false, run: fake.run };
    await renderSong(options);
    await assert.rejects(renderSong(options), /already rendered: .*night-shift\.wav.*Pass --force to replace/);
    assert.equal(fake.calls.length, 1);
    await renderSong({ ...options, force: true });
    assert.equal(fake.calls.length, 2);
    const file = join(dir, 'v.strudel.js');
    writeFileSync(file, `// @cycles 4\n$: variation("<1 2>").pam()\n`);
    await assert.rejects(renderSong({ song: file, preset: song('techno/night-shift.preset'), outDir: dir, mp3: false, run: fake.run }), /switches to variation 1, 2, which the preset does not have|switches to variation 2, which the preset does not have/);
    await assert.rejects(renderSong({ song: file }), /where should the render go/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildKit: programs through song make, roots read back, one mapcli pass per variation', async () => {
  const dir = scratch();
  try {
    const fake = fakeMapcli();
    const out = join(dir, 'kit.preset');
    const built = await buildKit({
      kit: {
        name: 'Test',
        tempo: 100,
        programs: { cmi: { 5: 'acid_bass' } },
        channels: 'cell',
        pitched: [5, 2],
        state: { cell1_synthEngine: 'Kick', cell2_mode: 'Loop', cell1_volume: -3 },
        patterns: { 1: 'x*4', 5: { mini: '<c2 eb2>', bars: 2 } },
        variations: { 2: { state: { cell1_volume: -9 }, patterns: { 1: '' } } },
      },
      out,
      run: fake.run,
    });
    assert.deepEqual(built, { preset: out, roots: { 2: 48, 5: 36 }, slots: [1, 2] });
    assert.equal(readFileSync(out, 'utf8'), '--save', 'the last pass is moved into place');
    const world = join(dir, '.kit.preset.work', 'programs.world.preset');
    assert.deepEqual(fake.calls.map((c) => c.args.slice(0, 2).join(' ')), ['song make', `preset read`, `state ${world}`, `state ${world}`, 'state kit-1.preset', 'state kit-2.preset']);
    assert.deepEqual(fake.calls[2].args.slice(2), ['--keys', 'cell1_synthEngine,cell2_mode,cell1_volume'], 'the kit keys are checked against the state first');
    const first = fake.calls[3];
    assert.equal(first.args[first.args.indexOf('--tempo') + 1], '100');
    const delta = first.files.envelopes[0].delta;
    assert.equal(delta.cell1_synthEngine, 1, 'an engine by name');
    assert.equal(delta.cell2_mode, 2, 'an enum by label');
    assert.equal(delta.cell1_volume, -3);
    assert.deepEqual(delta.cells[5], { midiChannel: 5, isPoly: 1, polyRootNote: 36, midiNote: 36, stepPropertyMode: 0 });
    assert.deepEqual(delta.cells[2], { midiChannel: 2, isPoly: 1, polyRootNote: 48, midiNote: 48 });
    assert.equal(delta.cell1_midiSequence.length, 4);
    assert.deepEqual(delta.cell5_midiSequence.map((n) => n.note), [36, 39]);
    assert.equal(delta.cell5_patternLength, 8);
    const second = fake.calls[4];
    assert.deepEqual(second.files.envelopes[0].delta, { cell1_volume: -9, cell1_midiSequence: [] });
    assert.deepEqual([second.args[second.args.indexOf('--variation') + 1], second.args[second.args.indexOf('--save-slot') + 1]], ['1', '2']);
    assert.equal(fake.calls[5].args[fake.calls[5].args.indexOf('--save-slot') + 1], '1', 'a last pass re-saves slot 1 so the preset opens on it');
    assert.equal(existsSync(join(dir, '.kit.preset.work')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildKit refuses to replace a preset, unknown engines, and samples without a library', async () => {
  const dir = scratch();
  try {
    const fake = fakeMapcli();
    const out = join(dir, 'kit.preset');
    writeFileSync(out, 'mine');
    await assert.rejects(buildKit({ kit: {}, out, run: fake.run }), /exists\. Pass --force to replace it/);
    assert.equal(readFileSync(out, 'utf8'), 'mine');
    await assert.rejects(buildKit({ kit: { state: { cell1_synthEngine: 'Gong' } }, out, force: true, run: fake.run }), /no drum-synth engine "Gong"/);
    await assert.rejects(
      buildKit({ kit: { state: { cell1_volume: 0, cell1_volumeTypo: 1 }, variations: { 2: { state: { cell2_Typo: 1 } } } }, out, force: true, run: fake.run }),
      /state keys PAM does not have: cell1_volumeTypo, cell2_Typo/,
    );
    assert.equal(readFileSync(out, 'utf8'), 'mine', 'a refused kit leaves the old preset');
    await assert.rejects(buildKit({ kit: { samples: { 3: 'a/b.wav' } }, out, force: true, run: fake.run }), /pass --library/);
    await assert.rejects(buildKit({ kit: { samples: { 3: 'a/b.wav' } }, out, force: true, library: dir, run: fake.run }), /cell 3: no sample at/);
    await assert.rejects(buildKit({ kit: { patterns: { 1: 'bd sd' } }, out, force: true, run: fake.run }), /cannot tell what "bd sd" plays/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
