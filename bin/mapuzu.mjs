#!/usr/bin/env node
/*
mapuzu.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The `mapuzu` command: serve, tidal, fake-clock, render, freeze, kit, midimap, params, to-pam, from-pam.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { actionTarget } from '../src/pam/midimap.mjs';

const HELP = `mapuzu: Strudel, TidalCycles and PAM

  mapuzu serve [--port <n>]                        serve this package to a page that already runs Strudel
                                                   (strudel.cc), and print the lines to paste there
  mapuzu tidal [--port <n>] [--setup <text>]       listen for TidalCycles' pamTarget (mapaudio.tidal) and play PAM:
                                                   OSC in on UDP, MIDI out through the page it prints
  mapuzu tidal --boot [--out <mapaudio.tidal>]     write the Tidal boot script, from PAM's parameter table
  mapuzu fake-clock [--bpm <n>] [--port <n>]       a stand-in for PAM's clock output, to try
                                                   pamsetup({ follow: true }) with no PAM running
  mapuzu render <song.strudel.js> --out <folder>   freeze the song into its preset and render WAV + MP3
      [--preset <file>] [--cycles <n>] [--tail <seconds>] [--seed <n>] [--sample-rate <hz>]
      [--stems] [--no-mp3] [--force] [--library <folder>] [--allow-missing]
  mapuzu freeze <song.strudel.js>                  say what the song freezes to, without rendering
      [--preset <file>] [--cycles <n>] [--envelopes <file.json>]
  mapuzu kit <kit.json> --out <file.preset>        build a preset from a kit  [--force] [--library <folder>]
  mapuzu midimap [<song.strudel.js>]               the mapping file that PAM imports (Settings > Mappings > Import):
                                                   what the song uses, or every parameter and action without one
      [--all] [--params <id,id>] [--cycles <n>] [--channel <0-16>] [--merge <exported.json>] [--out <file>]
  mapuzu params [<text>] [--cell <n>] [--json]     PAM's mappable parameters, with range and unit
  mapuzu to-pam "<mini-notation>" --cell <n> --bars <n>   a pattern, sampled, as PAM note lanes
      [--as note|n|hit] [--code <file.strudel.js>] [--preset <in> --out <out.preset> [--slot <n>]]
  mapuzu from-pam <file.preset>                    a preset's note lanes as Strudel code
      [--variation <n>] [--cells <n,n>]

  --mapcli <path>   the mapcli to run (default: $MAPCLI, else mapcli on the PATH)
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    preset: { type: 'string' },
    cycles: { type: 'string' },
    tail: { type: 'string' },
    seed: { type: 'string' },
    'sample-rate': { type: 'string' },
    stems: { type: 'boolean' },
    'no-mp3': { type: 'boolean' },
    force: { type: 'boolean' },
    library: { type: 'string' },
    'allow-missing': { type: 'boolean' },
    envelopes: { type: 'string' },
    all: { type: 'boolean' },
    params: { type: 'string' },
    channel: { type: 'string' },
    merge: { type: 'string' },
    cell: { type: 'string' },
    cells: { type: 'string' },
    json: { type: 'boolean' },
    bars: { type: 'string' },
    as: { type: 'string' },
    code: { type: 'string' },
    slot: { type: 'string' },
    variation: { type: 'string' },
    mapcli: { type: 'string' },
    port: { type: 'string' },
    bpm: { type: 'string' },
    setup: { type: 'string' },
    boot: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...rest] = positionals;
const number = (value, name) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} is not a number: ${value}`);
  return n;
};
const note = (message) => process.stderr.write(`${message}\n`);

function printReport(frozen) {
  const { report } = frozen;
  note(`${frozen.haps} events, ${frozen.cycles} cycles at ${Math.round(frozen.bpm * 100) / 100} BPM = ${frozen.seconds.toFixed(1)} s`);
  for (const [cell, c] of Object.entries(report.cells)) {
    const lanes = c.lanes.map((l) => `${l.target} (${l.steps} steps)`).join(', ');
    note(`  cell ${cell}: ${c.notes} notes${lanes ? `, lanes: ${lanes}` : ''}`);
  }
  if (report.static.length) note(`  set once: ${report.static.join(', ')}`);
  if (report.song) note(`  song: ${report.song.map((s) => `v${s.variation} bars ${s.bars[0]}-${s.bars[1]}`).join(', ')}`);
  for (const u of report.unsupported) note(`  NOT FROZEN ${u.what}: ${u.reason}`);
  for (const p of frozen.problems) note(`  problem: ${p}`);
}

async function main() {
  if (flags.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'serve') {
    const { serve } = await import('../src/node/serve.mjs');
    const { url } = await serve({ port: number(flags.port, 'port') });
    process.stdout.write(`serving ${url} to this machine\n\nIn the REPL at https://strudel.cc (single quotes: the REPL reads double ones as mini-notation):\n\n  await import('${url}')\n  await pamsetup()\n\n`);
    return;
  }
  if (command === 'tidal') {
    if (flags.boot) {
      const { bootFile } = await import('../src/tidal/boot.mjs');
      if (!flags.out) process.stdout.write(bootFile());
      else {
        writeFileSync(flags.out, bootFile());
        note(`wrote ${flags.out}`);
      }
      return;
    }
    const { tidal } = await import('../src/node/tidal.mjs');
    const { bootLines } = await import('../src/tidal/boot.mjs');
    const { url, udpPort } = await tidal({ port: number(flags.port, 'port'), setup: flags.setup, log: note });
    const boot = fileURLToPath(new URL('../mapaudio.tidal', import.meta.url));
    process.stdout.write(
      `listening for TidalCycles on UDP ${udpPort}\n\n1. Open ${url} and leave it open: that page is the MIDI port.\n2. In BootTidal.hs, load mapaudio.tidal and give the stream pamOscMap:\n\n${bootLines(boot, '   ')}\n\n`,
    );
    return;
  }
  if (command === 'fake-clock') {
    const { createFakeClock, serveClock } = await import('../src/node/fake-clock.mjs');
    const clock = createFakeClock({ bpm: number(flags.bpm, 'bpm') });
    const { url, port } = await serveClock(clock, { port: number(flags.port, 'port') });
    clock.play();
    const base = `http://127.0.0.1:${port}`;
    process.stdout.write(`a fake PAM clock at ${url}, playing\n\nIn the REPL, in your pamsetup:  follow: '${url}'\nMove it:      curl ${base}/stop   ${base}/play   '${base}/seek?ppq=16'   '${base}/bpm?value=140'\n\n`);
    return;
  }
  const node = await import('../src/node/index.mjs');
  const pam = await import('../src/pam/index.mjs');

  if (command === 'render') {
    if (!rest[0]) throw new Error('which song? mapuzu render <song.strudel.js> --out <folder>');
    const record = await node.renderSong({
      song: rest[0],
      preset: flags.preset,
      outDir: flags.out,
      cycles: number(flags.cycles, 'cycles'),
      tail: number(flags.tail, 'tail'),
      seed: number(flags.seed, 'seed'),
      sampleRate: number(flags['sample-rate'], 'sample-rate'),
      mp3: !flags['no-mp3'],
      stems: flags.stems,
      force: flags.force,
      library: flags.library,
      allowMissing: flags['allow-missing'],
      mapcli: flags.mapcli,
      log: note,
    });
    printReport({ ...record, haps: record.events });
    process.stdout.write(`${record.wav}\n${record.mp3 ? `${record.mp3}\n` : ''}`);
    return;
  }

  if (command === 'freeze') {
    if (!rest[0]) throw new Error('which song? mapuzu freeze <song.strudel.js>');
    const frozen = await node.freezeSong({ song: rest[0], preset: flags.preset, cycles: number(flags.cycles, 'cycles') });
    printReport(frozen);
    if (flags.envelopes) {
      writeFileSync(flags.envelopes, JSON.stringify([{ delta: frozen.delta }, ...(frozen.song ? [{ delta: { songMode: frozen.song } }] : [])]));
      note(`envelopes: ${flags.envelopes}`);
    }
    return;
  }

  if (command === 'kit') {
    if (!rest[0] || !flags.out) throw new Error('mapuzu kit <kit.json> --out <file.preset>');
    const built = await node.buildKit({ kit: rest[0], out: flags.out, force: flags.force, library: flags.library, mapcli: flags.mapcli, log: note });
    const roots = Object.entries(built.roots).map(([c, r]) => `cell ${c} root ${r}`);
    note(`variations ${built.slots.join(', ')}${roots.length ? `; ${roots.join(', ')}` : ''}`);
    process.stdout.write(`${built.preset}\n`);
    return;
  }

  if (command === 'midimap') {
    let params = flags.params ? flags.params.split(',').map((s) => s.trim()).filter(Boolean) : [];
    let actions = [];
    if (rest[0]) {
      const frozen = await node.freezeSong({ song: rest[0], preset: flags.preset, cycles: number(flags.cycles, 'cycles') });
      const used = usedTargets(frozen.timeline);
      params = [...new Set([...params, ...used.params])];
      actions = used.actions;
    }
    const channel = number(flags.channel, 'channel') ?? 0;
    // With no song and no list, the whole map.
    const everything = flags.all || (!rest[0] && !flags.params);
    const rows = everything ? pam.mappingRows({ channel }) : pam.mappingRows({ params, actions, channel });
    let merged = rows;
    if (flags.merge) {
      // PAM's import replaces the whole list: keep what it had, minus older mapuzu rows.
      const before = JSON.parse(readFileSync(flags.merge, 'utf8'));
      if (!Array.isArray(before)) throw new Error(`${flags.merge} is not a PAM mapping export (a JSON array)`);
      merged = [...before.filter((r) => !String(r?.id).startsWith('mapuzu-')), ...rows];
    }
    const text = `${JSON.stringify(merged, null, 1)}\n`;
    if (flags.out) {
      if (existsSync(flags.out) && !flags.force) throw new Error(`${flags.out} exists. Pass --force to replace it`);
      writeFileSync(flags.out, text);
      note(`${rows.length} rows${flags.merge ? ` (+ ${merged.length - rows.length} kept)` : ''}: ${flags.out}`);
    } else process.stdout.write(text);
    return;
  }

  if (command === 'params') {
    const text = (rest[0] ?? '').toLowerCase();
    const cell = number(flags.cell, 'cell');
    const list = pam.listParams({ cells: cell ? [cell] : [1], match: (id, p) => !text || id.toLowerCase().includes(text) || (p.label ?? '').toLowerCase().includes(text) || (p.group ?? '').toLowerCase().includes(text) });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(list, null, 1)}\n`);
      return;
    }
    for (const p of list) {
      const name = p.scope === 'cell' && !cell ? p.suffix : p.id;
      const range = p.labels ? p.labels.join(' | ') : `${p.min} .. ${p.max}${p.unit ? ` ${p.unit}` : ''}`;
      const marks = [p.fixed ? 'no lane' : '', p.hidden ? 'not in PAM\'s picker' : ''].filter(Boolean).join(', ');
      process.stdout.write(`${name.padEnd(30)} ${range}${marks ? `  (${marks})` : ''}\n`);
    }
    return;
  }

  if (command === 'to-pam') {
    const bars = number(flags.bars, 'bars');
    let setup;
    if (flags.preset) {
      setup = pam.setupFromState(node.readPreset(flags.preset).state);
    }
    const result = await node.patternToSequences({
      mini: flags.code ? undefined : rest[0],
      code: flags.code ? readFileSync(flags.code, 'utf8') : undefined,
      cell: number(flags.cell, 'cell'),
      as: flags.as ?? 'auto',
      bars,
      setup,
    });
    result.problems.forEach((p) => note(`problem: ${p}`));
    for (const [cell, c] of Object.entries(result.report.cells)) note(`cell ${cell}: ${c.notes} notes, ${result.report.clock.length} beats at speed index ${result.report.clock.speed}`);
    result.report.unsupported.forEach((u) => note(`NOT FROZEN ${u.what}: ${u.reason}`));
    const envelopes = [{ delta: result.delta }];
    if (!flags.preset) {
      process.stdout.write(`${JSON.stringify(envelopes)}\n`);
      return;
    }
    if (!flags.out) throw new Error('--preset needs --out <file.preset> for the result');
    if (existsSync(flags.out)) throw new Error(`${flags.out} exists: mapcli does not replace a preset`);
    const file = `${flags.out}.envelopes.json`;
    writeFileSync(file, JSON.stringify(envelopes));
    try {
      const slot = number(flags.slot, 'slot');
      await node.mapcli(['state', flags.preset, ...(slot ? ['--variation', String(slot), '--save-slot', String(slot)] : []), '--envelopes', file, '--save', flags.out, '--keys', 'currentVariation'], { mapcli: flags.mapcli });
    } finally {
      rmSync(file, { force: true });
    }
    process.stdout.write(`${flags.out}\n`);
    return;
  }

  if (command === 'from-pam') {
    if (!rest[0]) throw new Error('which preset? mapuzu from-pam <file.preset>');
    const result = node.presetToStrudel(rest[0], {
      variation: number(flags.variation, 'variation'),
      cells: flags.cells ? flags.cells.split(',').map(Number) : undefined,
    });
    for (const c of result.cells) {
      const extra = [c.ignored ? `${c.ignored} notes that the cell never plays were left out` : '', c.quantized ? `moved onto a 1/${c.grid} grid by up to ${c.quantized} beat` : '', c.clipped ?? '', c.lengths ?? '', c.chance ? `chance on ${c.chance} notes not shown` : ''].filter(Boolean);
      note(`cell ${c.cell}: ${c.notes} notes, grid 1/${c.grid ?? '-'} beat${extra.length ? `; ${extra.join('; ')}` : ''}`);
    }
    process.stdout.write(result.code);
    return;
  }

  throw new Error(`unknown command "${command}". Try: mapuzu help`);
}

// The parameters and mapped actions that a song's events reach, for its mapping file.
function usedTargets(timeline) {
  const params = new Set();
  const actions = new Set();
  for (const entry of timeline) {
    for (const event of entry.events) {
      if (event.type === 'knob') params.add(event.param.id);
      else if (event.type === 'switch') actions.add(`${event.what}:${event.cell}`);
      // A press that goes through mapuzu's map, as the encoder decides it: one with a mapping
      // target.
      else if (event.type === 'press' && actionTarget(event.name, event.cell)) actions.add(event.cell ? `${event.name}:${event.cell}` : event.name);
    }
  }
  return { params: [...params], actions: [...actions] };
}

// A reader that stops early (`mapuzu params | head`) is not an error.
process.stdout.on('error', (err) => process.exit(err.code === 'EPIPE' ? 0 : 1));

main().catch((err) => {
  process.stderr.write(`mapuzu: ${err.message}\n`);
  process.exit(err.name === 'MapcliError' && err.exitCode === 3 ? 3 : 1);
});
